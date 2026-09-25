/**
 * Importar rutinas desde Word (.docx) o texto pegado — gratis y sin backend.
 *
 * Para .docx usamos mammoth.js (incluida en el repo en js/vendor/, no vía
 * CDN, para que funcione siempre: offline, o si el navegador/red bloquea
 * CDNs externas). Solo extrae texto, corre en el navegador, no sube el
 * archivo a ningún servidor. Si el archivo es .doc viejo (no .docx),
 * siempre queda la opción de pegar el texto de la rutina directamente.
 *
 * El parseo de texto libre es heurístico y soporta el formato típico de
 * una rutina de gimnasio en español:
 *   - Encabezados de día: "Día 1 - Pecho Hombro Tríceps", "Lunes", ...
 *   - Series x reps simples: "Press banca 4x10"
 *   - Series x reps en pirámide: "Banco plano con barra 4x10-8-8-6"
 *     (una cifra de reps por serie; si hay menos cifras que series, la
 *     última se repite para las series que faltan)
 *   - Descanso opcional: "... 4x10 descanso 90s"
 *   - Varios ejercicios pegados en la misma línea, separados por
 *     "combinado con" (superserie): se detectan todas las coincidencias
 *     "NxM" de la línea y el nombre de cada ejercicio es el texto entre
 *     una coincidencia y la siguiente.
 * El resultado es un borrador editable — el usuario lo revisa y corrige
 * antes de guardar.
 */

import { uid } from './state.js';
import { guessMuscleGroup } from './muscleGroups.js';

const MAMMOTH_LOCAL_PATH = new URL('./vendor/mammoth.browser.min.js', import.meta.url).href;
let mammothLoadPromise = null;

function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  if (mammothLoadPromise) return mammothLoadPromise;
  mammothLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MAMMOTH_LOCAL_PATH;
    script.onload = () => resolve(window.mammoth);
    script.onerror = () => reject(new Error('No se pudo cargar el lector de Word. Probá pegando el texto de la rutina.'));
    document.head.appendChild(script);
  });
  return mammothLoadPromise;
}

/** Extrae texto plano de un archivo .docx usando mammoth.js. */
export async function extractTextFromDocx(file) {
  const mammoth = await loadMammoth();
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

const DAY_HEADER_RE = /^(d[ií]a\s*[a-z0-9áéíóú]+\b.*|lunes\b.*|martes\b.*|mi[eé]rcoles\b.*|jueves\b.*|viernes\b.*|s[aá]bado\b.*|domingo\b.*)$/i;
const TOKEN_RE = /(\d+)\s*[x×]\s*(\d+(?:[-–]\d+)*)/gi;
const HAS_TOKEN_RE = /\d+\s*[x×]\s*\d+/i;
const REST_RE = /descanso\s*[:\-]?\s*(\d+)\s*(seg(?:undos)?|s\b|min(?:utos)?)?/i;

function toSeconds(num, unit) {
  const n = parseInt(num, 10);
  if (!n) return null;
  if (unit && unit.startsWith('min')) return n * 60;
  return n;
}

/** Quita prefijos que no son parte del nombre del ejercicio ("combinado con...", "descanso 90s ..."). */
function cleanExerciseName(raw) {
  let s = raw;
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(/^\s*[,.\-–:]+\s*/, '')
      .replace(/^\s*(combinado|combinada)\s+con\s+/i, '')
      .replace(/^\s*descanso\s*[:\-]?\s*\d+\s*(seg(?:undos)?|s\b|min(?:utos)?)?\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * Encuentra todos los ejercicios de una línea (puede haber más de uno,
 * pegados con "combinado con"). Devuelve [] si no hay ningún patrón NxM.
 */
function parseExerciseLine(line) {
  const tokens = [];
  const re = new RegExp(TOKEN_RE);
  let m;
  while ((m = re.exec(line))) {
    tokens.push({
      start: m.index,
      end: m.index + m[0].length,
      sets: parseInt(m[1], 10) || 3,
      repsScheme: m[2].split(/[-–]/).map(n => parseInt(n, 10)).filter(Boolean),
    });
  }
  if (!tokens.length) return [];

  const results = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const nameStart = i === 0 ? 0 : tokens[i - 1].end;
    const name = cleanExerciseName(line.slice(nameStart, tok.start));
    if (!name) continue; // ej: dos esquemas de series pegados sin nombre nuevo en el medio
    const afterEnd = i + 1 < tokens.length ? tokens[i + 1].start : line.length;
    const restMatch = line.slice(tok.end, afterEnd).match(REST_RE);
    results.push({
      name: capitalize(name),
      sets: tok.sets,
      repsScheme: tok.repsScheme.length ? tok.repsScheme : [10],
      restSeconds: restMatch ? (toSeconds(restMatch[1], restMatch[2]) || 90) : 90,
    });
  }
  return results;
}

/**
 * Parsea texto libre de una rutina en días + ejercicios.
 * Devuelve { days, warnings } — days siempre es un array (puede tener
 * un único "Día 1" si el texto no trae encabezados de día).
 */
export function parseRoutineText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const days = [];
  let current = null;
  let unmatchedLines = 0;

  for (const line of lines) {
    if (DAY_HEADER_RE.test(line) && !HAS_TOKEN_RE.test(line)) {
      current = { id: uid(), name: capitalize(line), exercises: [] };
      days.push(current);
      continue;
    }
    const parsed = parseExerciseLine(line);
    if (parsed.length) {
      if (!current) { current = { id: uid(), name: 'Día 1', exercises: [] }; days.push(current); }
      for (const p of parsed) {
        current.exercises.push({
          id: uid(),
          name: p.name,
          muscleGroup: guessMuscleGroup(p.name),
          sets: p.sets,
          repsScheme: p.repsScheme,
          restSeconds: p.restSeconds,
        });
      }
    } else if (line.length > 2) {
      unmatchedLines++;
    }
  }

  const totalExercises = days.reduce((a, d) => a + d.exercises.length, 0);
  const warnings = [];
  if (!totalExercises) {
    warnings.push('No pude detectar ningún ejercicio. Revisá el formato (ej: "Press banca 4x10" o "Press banca 4x10-8-8-6") o cargá la rutina a mano.');
  } else if (unmatchedLines > totalExercises) {
    warnings.push('Encontré varias líneas que no pude interpretar. Revisá el borrador antes de guardar: puede faltar algún ejercicio.');
  }

  return { days, warnings };
}

export const PASTE_PLACEHOLDER = `Día 1 - Pecho y Tríceps
Press banca 4x10 descanso 90s
Aperturas con mancuernas 3x12-10-10 descanso 60s
Fondos en paralelas 3x10-8-6 descanso 90s

Día 2 - Espalda y Bíceps
Remo con barra 4x10 descanso 90s
Jalón al pecho 4x12-10-10-8 descanso 60s
Curl con barra 3x12 descanso 60s`;
