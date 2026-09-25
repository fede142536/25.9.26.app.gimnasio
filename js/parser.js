/**
 * Importar rutinas desde Word (.docx) o texto pegado — gratis y sin backend.
 *
 * Para .docx usamos mammoth.js desde un CDN público (solo extrae texto,
 * corre en el navegador, no sube el archivo a ningún servidor). Si no hay
 * conexión a internet para cargar esa librería, o el archivo es .doc viejo,
 * siempre queda la opción de pegar el texto de la rutina directamente:
 * esa vía funciona 100% offline.
 *
 * El parseo de texto libre es heurístico: separa por "días" y detecta
 * líneas con el patrón "Ejercicio 4x10 descanso 90s". El resultado es un
 * borrador editable — el usuario lo revisa y corrige antes de guardar.
 */

import { uid } from './state.js';
import { guessMuscleGroup } from './muscleGroups.js';

const MAMMOTH_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
let mammothLoadPromise = null;

function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  if (mammothLoadPromise) return mammothLoadPromise;
  mammothLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MAMMOTH_CDN;
    script.onload = () => resolve(window.mammoth);
    script.onerror = () => reject(new Error('No se pudo cargar el lector de Word (¿sin conexión?). Probá pegando el texto de la rutina.'));
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
// nombre del ejercicio, luego series x reps (acepta "x" o "×"), luego opcionalmente "descanso 90s" / "90 seg" / "1 min"
const EXERCISE_RE = /^[-•*•]?\s*(.+?)[\s:.\-–]*?(\d+)\s*[x×]\s*(\d+)(?:\s*(?:reps?|repeticiones))?\b\s*(?:[,.\-–]|\bdescanso\b|\brest\b)?\s*(?:descanso\s*[:\-]?\s*|rest\s*[:\-]?\s*)?(\d+)?\s*(seg|s|segundos|min|minutos)?/i;

function toSeconds(num, unit) {
  if (!num) return null;
  const n = parseInt(num, 10);
  if (!n) return null;
  if (unit && unit.startsWith('min')) return n * 60;
  return n;
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
    if (DAY_HEADER_RE.test(line) && !EXERCISE_RE.test(line)) {
      current = { id: uid(), name: capitalize(line), exercises: [] };
      days.push(current);
      continue;
    }
    const m = line.match(EXERCISE_RE);
    if (m) {
      const [, rawName, sets, reps, restNum, restUnit] = m;
      const name = capitalize(rawName.replace(/[:\-–]+$/, '').trim());
      if (!name) { unmatchedLines++; continue; }
      if (!current) { current = { id: uid(), name: 'Día 1', exercises: [] }; days.push(current); }
      current.exercises.push({
        id: uid(),
        name,
        muscleGroup: guessMuscleGroup(name),
        sets: parseInt(sets, 10) || 3,
        reps: parseInt(reps, 10) || 10,
        restSeconds: toSeconds(restNum, restUnit) || 90,
      });
    } else if (line.length > 2) {
      unmatchedLines++;
    }
  }

  const totalExercises = days.reduce((a, d) => a + d.exercises.length, 0);
  const warnings = [];
  if (!totalExercises) {
    warnings.push('No pude detectar ningún ejercicio. Revisá el formato (ej: "Press banca 4x10 descanso 90s") o cargá la rutina a mano.');
  } else if (unmatchedLines > totalExercises) {
    warnings.push('Encontré varias líneas que no pude interpretar. Revisá el borrador antes de guardar: puede faltar algún ejercicio.');
  }

  return { days, warnings };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const PASTE_PLACEHOLDER = `Día 1 - Pecho y Tríceps
Press banca 4x10 descanso 90s
Aperturas con mancuernas 3x12 descanso 60s
Fondos en paralelas 3x10 descanso 90s

Día 2 - Espalda y Bíceps
Remo con barra 4x10 descanso 90s
Jalón al pecho 4x12 descanso 60s
Curl con barra 3x12 descanso 60s`;
