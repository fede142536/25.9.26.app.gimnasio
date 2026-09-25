/**
 * Modelo de datos y persistencia.
 *
 * Todo vive en localStorage bajo una sola clave (GIMNASIO). No hay backend:
 * es la forma gratuita de guardar datos, pero implica que solo existen en
 * este navegador/dispositivo. `exportBackup`/`importBackup` sirven como
 * respaldo manual (un archivo .json que el usuario puede guardar aparte).
 *
 * Esquema:
 * state = {
 *   routines: [{
 *     id, name, startDate ('YYYY-MM-DD'), createdAt, source: 'manual'|'word'|'texto',
 *     days: [{ id, name, exercises: [{ id, name, muscleGroup, sets, reps, restSeconds }] }]
 *   }],
 *   activeRoutineId,
 *   logs: [{ id, ts, date, routineId, dayId, exerciseId, exerciseName, exerciseKey,
 *            muscleGroup, weight, reps, setNumber, weekNumber, weekInBlock, phase }],
 *   settings: { mesocycleWeeks, deloadFactor, incrementUpper, incrementLower, repIncrement },
 *   selectedDayId
 * }
 */

export const STORAGE_KEY = 'gimnasio_v2';
const LEGACY_KEY = 'musculacion_v1';

export const DEFAULT_SETTINGS = {
  mesocycleWeeks: 4,     // semanas por bloque antes de una semana de descarga
  deloadFactor: 0.55,    // fracción de peso que se mantiene en la semana de descarga
  incrementUpper: 2.5,   // kg que se suman al progresar en tren superior/torso
  incrementLower: 5,     // kg que se suman al progresar en tren inferior
  repIncrement: 1,       // reps que se suman cuando no se puede subir el peso (ej. peso corporal)
};

function emptyState() {
  return { routines: [], activeRoutineId: null, logs: [], settings: { ...DEFAULT_SETTINGS }, selectedDayId: null };
}

/** Convierte la rutina única de la app anterior (v1) en una rutina del nuevo modelo. */
function migrateLegacy() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const old = JSON.parse(raw);
    if (!old || !Array.isArray(old.days) || !old.days.length) return null;

    const routineId = uid();
    const routine = {
      id: routineId,
      name: 'Rutina importada',
      startDate: todayISO(),
      createdAt: Date.now(),
      source: 'manual',
      days: old.days.map(d => ({
        id: d.id || uid(),
        name: d.name || 'Día',
        exercises: (d.exercises || []).filter(e => e.name).map(e => ({
          id: e.id || uid(),
          name: e.name,
          muscleGroup: 'Otro',
          sets: e.sets || 3,
          repsScheme: [e.reps || 10],
          restSeconds: e.rest || 90,
        })),
      })),
    };

    const state = emptyState();
    state.routines = [routine];
    state.activeRoutineId = routineId;
    state.selectedDayId = routine.days[0]?.id || null;

    // Migramos también el historial de series, enlazándolo a la nueva rutina.
    const exByOldId = new Map();
    for (const d of routine.days) for (const e of d.exercises) exByOldId.set(e.id, e);
    state.logs = (old.logs || []).map(l => {
      const ex = exByOldId.get(l.exerciseId);
      return {
        id: l.id || uid(),
        ts: l.ts || Date.now(),
        date: l.date || todayISO(),
        routineId,
        dayId: l.dayId,
        exerciseId: l.exerciseId,
        exerciseName: ex ? ex.name : '',
        exerciseKey: ex ? normalizeName(ex.name) : '',
        muscleGroup: ex ? ex.muscleGroup : 'Otro',
        weight: l.weight,
        reps: l.reps,
        setNumber: 1,
      };
    });

    return state;
  } catch (e) {
    return null;
  }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // completar settings faltantes si se agregaron campos nuevos con el tiempo
      parsed.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
      return parsed;
    }
  } catch (e) { /* localStorage corrupto o bloqueado: seguimos con estado vacío/migrado */ }

  const migrated = migrateLegacy();
  if (migrated) {
    saveState(migrated);
    return migrated;
  }
  return emptyState();
}

export function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* almacenamiento lleno o bloqueado */ }
}

export function uid() { return Math.random().toString(36).slice(2, 9); }

export function todayISO() { return new Date().toISOString().slice(0, 10); }

export function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00');
  const b = new Date(isoB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/** Normaliza un nombre de ejercicio para poder relacionarlo entre distintas rutinas. */
export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getRoutine(state, id) {
  return state.routines.find(r => r.id === id) || null;
}

export function getActiveRoutine(state) {
  return getRoutine(state, state.activeRoutineId) || state.routines[0] || null;
}

export function findExercise(state, routineId, dayId, exId) {
  const routine = getRoutine(state, routineId);
  const day = routine?.days.find(d => d.id === dayId);
  return day?.exercises.find(e => e.id === exId) || null;
}

/**
 * Esquema de repeticiones por ejercicio: un array, una cifra por serie
 * (ej. [10, 8, 8, 6] para una pirámide descendente). Si hay menos cifras
 * que series, la última se repite para las series que faltan.
 */
export function repsForSetIndex(ex, setIndex) {
  const scheme = ex.repsScheme && ex.repsScheme.length ? ex.repsScheme : [10];
  return scheme[Math.min(setIndex, scheme.length - 1)];
}

/** Etiqueta legible del esquema: "10" si es uniforme, "10-8-8-6" si varía. */
export function repsSchemeLabel(ex) {
  const scheme = ex.repsScheme && ex.repsScheme.length ? ex.repsScheme : [10];
  return scheme.length > 1 ? scheme.join('-') : String(scheme[0]);
}

/** Convierte lo que se tipeó en el formulario ("10" o "10-8-8-6") en un array de reps válido. */
export function parseRepsSchemeInput(text) {
  const nums = String(text).split(/[^0-9]+/).filter(Boolean).map(n => parseInt(n, 10)).filter(n => n > 0);
  return nums.length ? nums : [10];
}

export function exportBackup(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gimnasio-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function importBackup(json) {
  const parsed = JSON.parse(json);
  if (!parsed || !Array.isArray(parsed.routines)) throw new Error('Archivo inválido');
  parsed.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
  return parsed;
}
