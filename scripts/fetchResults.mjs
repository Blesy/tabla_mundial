/**
 * fetchResults.mjs (v2 – ESPN API sin API key)
 * Lee mundial.json, consulta el scoreboard de ESPN por cada fecha con
 * partidos pendientes y actualiza los goles (y penales en eliminatorias).
 *
 * Uso:
 *   node scripts/fetchResults.mjs
 *   node scripts/fetchResults.mjs --dry-run
 *
 * No requiere ninguna variable de entorno ni API key.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'src', 'data', 'mundial.json');
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 600;

// ── ESPN API (sin autenticación) ─────────────────────────────────────────────
// Endpoint oficial no documentado de ESPN para el scoreboard de FIFA World Cup
const ESPN_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

// Mapeo de IDs propios → abreviaciones que usa ESPN
// La mayoría coincide con FIFA estándar; solo se listan las excepciones conocidas
const ESPN_MAP = {
  RSA: 'RSA',   // Sudáfrica
  CZE: 'CZE',   // Rep. Checa (ESPN también usa CZR; se prueba ambas abajo)
  BIH: 'BIH',   // Bosnia y Herz.
  CPV: 'CPV',   // Cabo Verde
  COD: 'DRC',   // R.D. Congo – ESPN usa DRC
  CIV: 'CIV',   // Costa de Marfil
  CUW: 'CUW',   // Curazao
  IRQ: 'IRQ',   // Irak
  UZB: 'UZB',   // Uzbekistán
  NZL: 'NZL',   // Nueva Zelanda
  SCO: 'SCO',   // Escocia
  HAI: 'HAI',   // Haití
  ALG: 'ALG',   // Argelia
  JOR: 'JOR',   // Jordania
  IRN: 'IRN',   // Irán
  SAU: 'KSA',   // Arabia Saudita – ESPN usa KSA
  NOR: 'NOR',   // Noruega
  SEN: 'SEN',   // Senegal
  GHA: 'GHA',   // Ghana
  PAN: 'PAN',   // Panamá
};

function espnAbbr(id) {
  return ESPN_MAP[id] ?? id;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hoy en YYYY-MM-DD usando offset fijo –7 h (igual que la versión anterior) */
function hoyLocal() {
  const d = new Date(Date.now() - 7 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "2026-06-11" → "20260611" (formato que acepta ESPN) */
function toESPNDate(fecha) {
  return fecha.replace(/-/g, '');
}

/** Suma 1 día a una fecha "YYYY-MM-DD" y devuelve la nueva en el mismo formato */
function nextDia(fecha) {
  const d = new Date(fecha + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Obtiene todos los eventos del scoreboard de ESPN para una fecha dada.
 * Devuelve un array de objetos event (puede estar vacío).
 */
async function fetchESPNScoreboard(fecha) {
  const url = `${ESPN_BASE}?dates=${toESPNDate(fecha)}`;
  console.log(`  GET ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fetchResults/2.0)' },
  });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status} para fecha ${fecha}`);
  const json = await res.json();
  return json.events ?? [];
}

/**
 * Busca en los eventos de ESPN el partido entre los equipos dados.
 * Devuelve { golesLocal, golesVisitante, penalesLocal, penalesVisitante } o null.
 * nombreEquipoMap es el lookup id→nombre en español (para fallback por nombre).
 */
function parsearPartidoESPN(events, localId, visitanteId, nombreEquipoMap) {
  const localAbbr = espnAbbr(localId).toUpperCase();
  const visitanteAbbr = espnAbbr(visitanteId).toUpperCase();

  for (const event of events) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const competitors = comp.competitors ?? [];
    if (competitors.length < 2) continue;

    // Buscar por abreviación exacta
    let cLocal = competitors.find(
      (c) => c.team?.abbreviation?.toUpperCase() === localAbbr,
    );
    let cVisitante = competitors.find(
      (c) => c.team?.abbreviation?.toUpperCase() === visitanteAbbr,
    );

    // Fallback: abreviación alternativa conocida (ej. CZE/CZR)
    if (!cLocal) {
      cLocal = competitors.find((c) => {
        const abbr = c.team?.abbreviation?.toUpperCase() ?? '';
        return abbr === localId.toUpperCase();
      });
    }
    if (!cVisitante) {
      cVisitante = competitors.find((c) => {
        const abbr = c.team?.abbreviation?.toUpperCase() ?? '';
        return abbr === visitanteId.toUpperCase();
      });
    }

    // Fallback: comparación por nombre de equipo
    if (!cLocal || !cVisitante) {
      const localNombre = (nombreEquipoMap[localId] ?? '').toLowerCase();
      const visitanteNombre = (nombreEquipoMap[visitanteId] ?? '').toLowerCase();
      const byName = (nombre) =>
        competitors.find((c) => {
          const dn = (
            c.team?.displayName ??
            c.team?.shortDisplayName ??
            ''
          ).toLowerCase();
          return (
            dn.includes(nombre.split(' ')[0]) ||
            nombre.split(' ')[0].includes(dn.split(' ')[0])
          );
        });
      if (!cLocal && localNombre) cLocal = byName(localNombre);
      if (!cVisitante && visitanteNombre) cVisitante = byName(visitanteNombre);
    }

    if (!cLocal || !cVisitante) continue;

    // Verificar que el partido haya terminado
    const status = comp.status?.type;
    if (!status?.completed) {
      console.log('  → Partido en curso o no iniciado todavía.');
      return null;
    }

    const golesLocal = parseInt(cLocal.score ?? '', 10);
    const golesVisitante = parseInt(cVisitante.score ?? '', 10);
    if (isNaN(golesLocal) || isNaN(golesVisitante)) return null;

    // ── Penales ───────────────────────────────────────────────────────────
    let penalesLocal = null;
    let penalesVisitante = null;

    // ESPN indica tanda de penales en shortDetail: "FT-Pens" / "Final (Pens)"
    const shortDetail = (status.shortDetail ?? status.detail ?? '').toLowerCase();
    // Solo buscar penales si el partido terminó empatado (penales no cambian el marcador oficial)
    if (shortDetail.includes('pen') && golesLocal === golesVisitante) {
      // Formato real de ESPN: "Morocco advance 3-2 on penalties"
      // El orden es GANADOR-PERDEDOR, no home-away
      const notesText = (comp.notes ?? [])
        .map((n) => n.headline ?? n.text ?? '')
        .join(' ');
      const penMatch = notesText.match(/(.+?)\s+advance[s]?\s+(\d+)\s*[–\-]\s*(\d+)\s*on\s+pen/i);
      if (penMatch) {
        const ganadorNombre = penMatch[1].trim().toLowerCase();
        const penGanador = parseInt(penMatch[2], 10);
        const penPerdedor = parseInt(penMatch[3], 10);

        // Determinar si el ganador es el local o el visitante
        const nombreLocal = (cLocal.team?.displayName ?? cLocal.team?.shortDisplayName ?? cLocal.team?.abbreviation ?? '').toLowerCase();
        const nombreVisitante = (cVisitante.team?.displayName ?? cVisitante.team?.shortDisplayName ?? cVisitante.team?.abbreviation ?? '').toLowerCase();

        const ganadorEsLocal =
          nombreLocal.includes(ganadorNombre.split(' ')[0]) ||
          ganadorNombre.includes(nombreLocal.split(' ')[0]);

        if (ganadorEsLocal) {
          penalesLocal = penGanador;
          penalesVisitante = penPerdedor;
        } else {
          penalesLocal = penPerdedor;
          penalesVisitante = penGanador;
        }
      }
    }

    return { golesLocal, golesVisitante, penalesLocal, penalesVisitante };
  }

  return null; // partido no encontrado en la respuesta de ESPN
}

/**
 * Intenta obtener el marcador de un partido desde ESPN.
 * Devuelve el resultado parseado o null si no hay datos disponibles aún.
 * events: array de eventos ya descargado para esa fecha.
 */
function obtenerMarcador(events, localId, visitanteId, nombreEquipoMap) {
  const nombreLocal = nombreEquipoMap[localId] ?? localId;
  const nombreVisitante = nombreEquipoMap[visitanteId] ?? visitanteId;
  console.log(`  Buscando: ${nombreLocal} vs ${nombreVisitante}`);

  const resultado = parsearPartidoESPN(events, localId, visitanteId, nombreEquipoMap);
  if (resultado) {
    const { golesLocal, golesVisitante, penalesLocal, penalesVisitante } = resultado;
    let log = `  → ${golesLocal}–${golesVisitante}`;
    if (penalesLocal !== null) log += ` (pen: ${penalesLocal}–${penalesVisitante})`;
    console.log(log);
  } else {
    console.log('  → Sin resultado disponible todavía.');
  }
  return resultado;
}

// ─── Lógica principal ────────────────────────────────────────────────────────

const mundial = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
const hoy = hoyLocal();

// Ayer en YYYY-MM-DD (mismo offset horario que hoyLocal)
const ayerDate = new Date(Date.now() - 7 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
const ayer = `${ayerDate.getUTCFullYear()}-${String(ayerDate.getUTCMonth() + 1).padStart(2, '0')}-${String(ayerDate.getUTCDate()).padStart(2, '0')}`;

let cambios = 0;

// Construir lookup id → nombre en español
const nombreEquipo = {};
for (const grupoKey of Object.keys(mundial.grupos)) {
  for (const eq of mundial.grupos[grupoKey].equipos) {
    nombreEquipo[eq.id] = eq.nombre;
  }
}

console.log(`\n=== fetchResults — ${hoy} (revisando también ${ayer}) ${DRY_RUN ? '[DRY-RUN]' : ''} ===\n`);

// ── Recolectar fechas únicas a consultar ──────────────────────────────────────
// En lugar de llamar a la API por cada partido (como hacía SerpAPI),
// agrupamos por fecha y hacemos UNA sola petición a ESPN por fecha.
const fechasNecesarias = new Set();

const todosLosPartidos = [
  ...Object.values(mundial.grupos).flatMap((g) =>
    g.partidos.map((p) => ({ ...p, _tipo: 'grupo' }))
  ),
  ...[
    ...(mundial.eliminatorias.treintaDos ?? []),
    ...(mundial.eliminatorias.dieciseis ?? []),
    ...(mundial.eliminatorias.cuartos ?? []),
    ...(mundial.eliminatorias.semis ?? []),
    mundial.eliminatorias.tercerLugar,
    mundial.eliminatorias.final,
  ]
    .filter(Boolean)
    .map((p) => ({ ...p, _tipo: 'elim' })),
];

for (const partido of todosLosPartidos) {
  if (!partido.fecha || partido.fecha > hoy) continue;
  if (
    partido.fecha < ayer &&
    partido.golesLocal !== null &&
    partido.golesVisitante !== null
  )
    continue;
  if (partido._tipo === 'elim' && (!partido.local || !partido.visitante)) continue;
  fechasNecesarias.add(partido.fecha);
  // Los partidos nocturnos (p. ej. 21:00 hora MX) pueden aparecer en ESPN
  // bajo la fecha UTC siguiente; siempre se descarga también el día siguiente.
  const siguiente = nextDia(partido.fecha);
  if (siguiente <= hoy) fechasNecesarias.add(siguiente);
}

// ── Descargar scoreboards de ESPN por fecha ───────────────────────────────────
const cacheESPN = {}; // fecha → events[]

for (const fecha of [...fechasNecesarias].sort()) {
  console.log(`\nDescargando scoreboard ESPN para ${fecha}…`);
  try {
    cacheESPN[fecha] = await fetchESPNScoreboard(fecha);
    console.log(`  → ${cacheESPN[fecha].length} evento(s) encontrado(s).`);
  } catch (err) {
    console.error(`  [ERROR] ${err.message}`);
    cacheESPN[fecha] = [];
  }
  await delay(DELAY_MS);
}

// ── Partidos de Grupos ────────────────────────────────────────────────────────
console.log('\n─── Grupos ──────────────────────────────────────────────────────');

for (const [letra, grupo] of Object.entries(mundial.grupos)) {
  for (const partido of grupo.partidos) {
    if (!partido.fecha || partido.fecha > hoy) continue;
    if (
      partido.fecha < ayer &&
      partido.golesLocal !== null &&
      partido.golesVisitante !== null
    )
      continue;

    const events = [
      ...(cacheESPN[partido.fecha] ?? []),
      ...(cacheESPN[nextDia(partido.fecha)] ?? []),
    ];
    console.log(`\nGrupo ${letra}: ${nombreEquipo[partido.local] ?? partido.local} vs ${nombreEquipo[partido.visitante] ?? partido.visitante} (${partido.fecha})`);
    const resultado = obtenerMarcador(events, partido.local, partido.visitante, nombreEquipo);

    if (resultado) {
      const cambioReal =
        resultado.golesLocal !== partido.golesLocal ||
        resultado.golesVisitante !== partido.golesVisitante;
      if (!DRY_RUN) {
        partido.golesLocal = resultado.golesLocal;
        partido.golesVisitante = resultado.golesVisitante;
      }
      if (cambioReal) cambios++;
    }
  }
}

// ── Partidos de Eliminatorias ─────────────────────────────────────────────────
console.log('\n─── Eliminatorias ───────────────────────────────────────────────');

const rondasElim = [
  { partidos: mundial.eliminatorias.treintaDos, nombre: 'Dieciseisavos' },
  { partidos: mundial.eliminatorias.dieciseis,  nombre: 'Octavos' },
  { partidos: mundial.eliminatorias.cuartos,    nombre: 'Cuartos' },
  { partidos: mundial.eliminatorias.semis,      nombre: 'Semifinales' },
  { partidos: [mundial.eliminatorias.tercerLugar], nombre: '3er Lugar' },
  { partidos: [mundial.eliminatorias.final],    nombre: 'Final' },
];

for (const { partidos, nombre } of rondasElim) {
  for (const partido of partidos) {
    if (!partido.local || !partido.visitante) continue;
    if (!partido.fecha || partido.fecha > hoy) continue;
    if (
      partido.fecha < ayer &&
      partido.golesLocal !== null &&
      partido.golesVisitante !== null
    )
      continue;

    const events = [
      ...(cacheESPN[partido.fecha] ?? []),
      ...(cacheESPN[nextDia(partido.fecha)] ?? []),
    ];
    console.log(`\n${nombre}: ${nombreEquipo[partido.local] ?? partido.local} vs ${nombreEquipo[partido.visitante] ?? partido.visitante} (${partido.fecha})`);
    const resultado = obtenerMarcador(events, partido.local, partido.visitante, nombreEquipo);

    if (resultado) {
      const cambioReal =
        resultado.golesLocal !== partido.golesLocal ||
        resultado.golesVisitante !== partido.golesVisitante ||
        resultado.penalesLocal !== (partido.penalesLocal ?? null) ||
        resultado.penalesVisitante !== (partido.penalesVisitante ?? null);
      if (!DRY_RUN) {
        partido.golesLocal = resultado.golesLocal;
        partido.golesVisitante = resultado.golesVisitante;
        if (resultado.penalesLocal !== null) {
          partido.penalesLocal = resultado.penalesLocal;
          partido.penalesVisitante = resultado.penalesVisitante;
        }
      }
      if (cambioReal) cambios++;
    }
  }
}

// ── Avanzar ganadores a la siguiente fase ────────────────────────────────────
console.log('\n─── Avanzando clasificados ──────────────────────────────────────');

/**
 * Dado un partido terminado, devuelve { ganador, perdedor } o null si el
 * resultado aún no es definitivo (marcador null o empate sin penales resueltos).
 */
function determinarGanador(partido) {
  if (partido.golesLocal === null || partido.golesVisitante === null) return null;
  if (!partido.local || !partido.visitante) return null;

  if (partido.golesLocal > partido.golesVisitante)
    return { ganador: partido.local, perdedor: partido.visitante };
  if (partido.golesVisitante > partido.golesLocal)
    return { ganador: partido.visitante, perdedor: partido.local };

  // Empate: solo resolver si los penales están definitivamente registrados
  if (partido.penalesLocal !== null && partido.penalesVisitante !== null) {
    if (partido.penalesLocal > partido.penalesVisitante)
      return { ganador: partido.local, perdedor: partido.visitante };
    if (partido.penalesVisitante > partido.penalesLocal)
      return { ganador: partido.visitante, perdedor: partido.local };
  }

  return null; // empate sin penales resueltos todavía
}

// Partidos que generan clasificados (todas las rondas excepto la final y 3er lugar)
const fuentesElim = [
  ...(mundial.eliminatorias.treintaDos ?? []),
  ...(mundial.eliminatorias.dieciseis  ?? []),
  ...(mundial.eliminatorias.cuartos    ?? []),
  ...(mundial.eliminatorias.semis      ?? []),
];

// Partidos que reciben clasificados (desde octavos hasta la final y 3er lugar)
const receptoresElim = [
  ...(mundial.eliminatorias.dieciseis ?? []),
  ...(mundial.eliminatorias.cuartos   ?? []),
  ...(mundial.eliminatorias.semis     ?? []),
  mundial.eliminatorias.tercerLugar,
  mundial.eliminatorias.final,
];

for (const fuente of fuentesElim) {
  const res = determinarGanador(fuente);
  if (!res) continue;

  const { ganador, perdedor } = res;

  for (const destino of receptoresElim) {
    // Si el partido destino ya tiene marcador definitivo, no tocar sus equipos
    const destinoJugado =
      destino.golesLocal !== null && destino.golesVisitante !== null;

    const slots = [
      { descKey: 'descLocal',     campoKey: 'local',      prefijo: 'G', equipo: ganador  },
      { descKey: 'descVisitante', campoKey: 'visitante',  prefijo: 'G', equipo: ganador  },
      { descKey: 'descLocal',     campoKey: 'local',      prefijo: 'P', equipo: perdedor },
      { descKey: 'descVisitante', campoKey: 'visitante',  prefijo: 'P', equipo: perdedor },
    ];

    for (const { descKey, campoKey, prefijo, equipo } of slots) {
      if (destino[descKey] !== `${prefijo} ${fuente.id}`) continue;
      if (destino[campoKey] === equipo) continue; // ya es correcto, sin cambio

      if (destinoJugado) {
        console.log(
          `  [AVISO] ${destino.id}.${campoKey}: se esperaba ${equipo} pero el partido ya tiene marcador — se omite`,
        );
        continue;
      }

      const nombre = nombreEquipo[equipo] ?? equipo;
      console.log(`  ${fuente.id} → ${destino.id}.${campoKey} = ${nombre}`);
      if (!DRY_RUN) destino[campoKey] = equipo;
      cambios++;
    }
  }
}

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log(`\n=== Resumen: ${cambios} partido(s)/clasificado(s) actualizado(s) ===`);

if (cambios > 0 && !DRY_RUN) {
  writeFileSync(DATA_PATH, JSON.stringify(mundial, null, 2) + '\n', 'utf-8');
  console.log('mundial.json actualizado.');
} else if (DRY_RUN && cambios > 0) {
  console.log('[DRY-RUN] No se escribió el archivo.');
} else {
  console.log('Sin cambios. mundial.json no modificado.');
}
