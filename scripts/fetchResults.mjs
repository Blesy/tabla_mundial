/**
 * fetchResults.mjs
 * Lee mundial.json, consulta SerpAPI por cada partido jugado sin marcador
 * y actualiza los goles (y penales en eliminatorias).
 *
 * Uso:
 *   node --env-file=.env scripts/fetchResults.mjs
 *   node --env-file=.env scripts/fetchResults.mjs --dry-run
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'src', 'data', 'mundial.json');
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 1500;

const SERPAPI_KEY = process.env.SERPAPI_KEY;
if (!SERPAPI_KEY) {
  console.error('[ERROR] SERPAPI_KEY no definida. Crea un archivo .env con tu API key.');
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hoy en YYYY-MM-DD usando la zona local (sin conversión a UTC)
 */
function hoyLocal() {
  const d = new Date(Date.now() - 7 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Llama a SerpAPI con la query indicada y devuelve el JSON de respuesta.
 */
async function fetchSerpApi(query) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('location', 'Mexico');
  url.searchParams.set('google_domain', 'google.com.mx');
  url.searchParams.set('gl', 'mx');
  url.searchParams.set('hl', 'es-419');
  url.searchParams.set('api_key', SERPAPI_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`SerpAPI HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Extrae marcador de un objeto sports_results de SerpAPI.
 * Devuelve { golesLocal, golesVisitante, penalesLocal, penalesVisitante }
 * o null si no se pudo parsear.
 *
 * SerpAPI puede devolver:
 *   sports_results.teams[0].score / teams[1].score
 *   sports_results.title  →  "México 2–1 Sudáfrica"  o  "España 1–1 (4–2 pen) Uruguay"
 *   sports_results.game_spotlight.teams[0].score / ...
 */
function parseSportsResults(data, nombreLocal, nombreVisitante) {
  const sr = data.sports_results;
  if (!sr) return null;

  // Intentar leer desde teams[] (formato más común)
  const teams =
    sr.teams ??
    sr.game_spotlight?.teams ??
    null;

  let golesLocal = null;
  let golesVisitante = null;
  let penalesLocal = null;
  let penalesVisitante = null;

  if (teams && teams.length === 2) {
    // Determinar cuál team es local y cuál es visitante
    // El order del query es "{local} vs {visitante}", así que teams[0] suele ser local
    const t0 = teams[0];
    const t1 = teams[1];

    const score0 = parseInt(t0.score ?? t0.result ?? '', 10);
    const score1 = parseInt(t1.score ?? t1.result ?? '', 10);

    if (!isNaN(score0) && !isNaN(score1)) {
      // Verificar que el nombre concuerde para detectar inversiones
      const name0 = (t0.name ?? '').toLowerCase();
      const name1 = (t1.name ?? '').toLowerCase();
      const localLow = nombreLocal.toLowerCase();
      const visitanteLow = nombreVisitante.toLowerCase();

      const t0esLocal =
        name0.includes(localLow) ||
        localLow.includes(name0) ||
        name0 === localLow;

      const t0esVisitante =
        name0.includes(visitanteLow) ||
        visitanteLow.includes(name0) ||
        name0 === visitanteLow;

      if (t0esLocal || (!t0esVisitante && true)) {
        // Orden normal: teams[0] = local
        golesLocal = score0;
        golesVisitante = score1;
      } else {
        // Invertido: teams[0] = visitante
        golesLocal = score1;
        golesVisitante = score0;
      }
    }
  }

  // Si no encontramos goles desde teams, intentar parsear el title
  if (golesLocal === null) {
    const title = sr.title ?? sr.game_spotlight?.title ?? '';
    // Ejemplo: "México 2 – 1 Sudáfrica"  |  "España 1 – 1 Uruguay"
    const matchScore = title.match(/(\d+)\s*[–\-]\s*(\d+)/);
    if (matchScore) {
      // Verificar orden de equipos en el título
      const localIdx = title.toLowerCase().indexOf(nombreLocal.toLowerCase().split(' ')[0]);
      const visitanteIdx = title.toLowerCase().indexOf(nombreVisitante.toLowerCase().split(' ')[0]);

      if (localIdx !== -1 && visitanteIdx !== -1 && localIdx < visitanteIdx) {
        golesLocal = parseInt(matchScore[1], 10);
        golesVisitante = parseInt(matchScore[2], 10);
      } else if (localIdx !== -1 && visitanteIdx !== -1 && visitanteIdx < localIdx) {
        golesLocal = parseInt(matchScore[2], 10);
        golesVisitante = parseInt(matchScore[1], 10);
      } else {
        // Sin contexto de posición, asumir orden del query
        golesLocal = parseInt(matchScore[1], 10);
        golesVisitante = parseInt(matchScore[2], 10);
      }
    }
  }

  if (golesLocal === null) return null;

  // Parsear penales si el partido terminó en empate
  // Título puede tener: "España 1–1 (4–2 pen) Uruguay"  o  "… (pens 4-2)"
  const tituloCompleto =
    (sr.title ?? '') +
    ' ' +
    (sr.game_spotlight?.title ?? '') +
    ' ' +
    (sr.summary ?? '');

  const penMatch = tituloCompleto.match(
    /\(\s*(\d+)\s*[–\-]\s*(\d+)\s*(?:pen|pens|penalt[a-z]*)\s*\)/i
  );
  if (penMatch) {
    // Misma lógica de orden: si el local aparece antes del visitante en el título
    const titulo = (sr.title ?? tituloCompleto).toLowerCase();
    const localIdx = titulo.indexOf(nombreLocal.toLowerCase().split(' ')[0]);
    const visitanteIdx = titulo.indexOf(nombreVisitante.toLowerCase().split(' ')[0]);

    if (localIdx !== -1 && visitanteIdx !== -1 && visitanteIdx < localIdx) {
      penalesLocal = parseInt(penMatch[2], 10);
      penalesVisitante = parseInt(penMatch[1], 10);
    } else {
      penalesLocal = parseInt(penMatch[1], 10);
      penalesVisitante = parseInt(penMatch[2], 10);
    }
  }

  return { golesLocal, golesVisitante, penalesLocal, penalesVisitante };
}

/**
 * Intenta obtener el marcador de un partido desde SerpAPI.
 * Devuelve el resultado parseado o null si no hay datos disponibles aún.
 */
async function obtenerMarcador(nombreLocal, nombreVisitante) {
  const query = `world cup 2026 ${nombreLocal} vs ${nombreVisitante}`;
  console.log(`  Consultando: "${query}"`);

  try {
    const data = await fetchSerpApi(query);
    const resultado = parseSportsResults(data, nombreLocal, nombreVisitante);
    if (resultado) {
      const { golesLocal, golesVisitante, penalesLocal, penalesVisitante } = resultado;
      let log = `  → ${golesLocal}–${golesVisitante}`;
      if (penalesLocal !== null) log += ` (pen: ${penalesLocal}–${penalesVisitante})`;
      console.log(log);
    } else {
      console.log('  → Sin resultado disponible todavía.');
    }
    return resultado;
  } catch (err) {
    console.error(`  [ERROR] ${err.message}`);
    return null;
  }
}

// ─── Lógica principal ────────────────────────────────────────────────────────

const mundial = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
const hoy = hoyLocal();
let cambios = 0;

// Construir lookup id → nombre en español
const nombreEquipo = {};
for (const grupoKey of Object.keys(mundial.grupos)) {
  for (const eq of mundial.grupos[grupoKey].equipos) {
    nombreEquipo[eq.id] = eq.nombre;
  }
}

console.log(`\n=== fetchResults — ${hoy} ${DRY_RUN ? '[DRY-RUN]' : ''} ===\n`);

// ── Partidos de Grupos ────────────────────────────────────────────────────────
console.log('─── Grupos ──────────────────────────────────────────────────────');

for (const [letra, grupo] of Object.entries(mundial.grupos)) {
  for (const partido of grupo.partidos) {
    // Solo actualizar partidos cuya fecha ya pasó y sin marcador
    // Para partidos de hoy se re-consulta aunque ya tengan marcador (pueden estar en curso)
    if (!partido.fecha || partido.fecha > hoy) continue;
    if (partido.fecha < hoy && (partido.golesLocal !== null || partido.golesVisitante !== null)) continue;

    const nombreLocal = nombreEquipo[partido.local] ?? partido.local;
    const nombreVisitante = nombreEquipo[partido.visitante] ?? partido.visitante;

    console.log(`\nGrupo ${letra}: ${nombreLocal} vs ${nombreVisitante} (${partido.fecha})`);

    await delay(DELAY_MS);
    const resultado = await obtenerMarcador(nombreLocal, nombreVisitante);

    if (resultado) {
      const cambioReal =
        resultado.golesLocal !== partido.golesLocal ||
        resultado.golesVisitante !== partido.golesVisitante;
      if (!DRY_RUN) {
        partido.golesLocal = resultado.golesLocal;
        partido.golesVisitante = resultado.golesVisitante;
        // Los partidos de grupos no tienen penales
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
  { partidos: mundial.eliminatorias.semis,       nombre: 'Semifinales' },
  { partidos: [mundial.eliminatorias.tercerLugar], nombre: '3er Lugar' },
  { partidos: [mundial.eliminatorias.final],     nombre: 'Final' },
];

for (const { partidos, nombre } of rondasElim) {
  for (const partido of partidos) {
    // Solo actualizar si el partido tiene equipos asignados, fecha pasada y sin marcador
    // Para partidos de hoy se re-consulta aunque ya tengan marcador (pueden estar en curso)
    if (!partido.local || !partido.visitante) continue;
    if (!partido.fecha || partido.fecha > hoy) continue;
    if (partido.fecha < hoy && (partido.golesLocal !== null || partido.golesVisitante !== null)) continue;

    const nombreLocal = nombreEquipo[partido.local] ?? partido.local;
    const nombreVisitante = nombreEquipo[partido.visitante] ?? partido.visitante;

    console.log(`\n${nombre}: ${nombreLocal} vs ${nombreVisitante} (${partido.fecha})`);

    await delay(DELAY_MS);
    const resultado = await obtenerMarcador(nombreLocal, nombreVisitante);

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

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log(`\n=== Resumen: ${cambios} partido(s) actualizado(s) ===`);

if (cambios > 0 && !DRY_RUN) {
  writeFileSync(DATA_PATH, JSON.stringify(mundial, null, 2) + '\n', 'utf-8');
  console.log('mundial.json actualizado.');
} else if (DRY_RUN && cambios > 0) {
  console.log('[DRY-RUN] No se escribió el archivo.');
} else {
  console.log('Sin cambios. mundial.json no modificado.');
}
