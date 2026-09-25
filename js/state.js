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
 *   settings: { mesocycleWeeks, deloadFactor, incrementUpper, incrementLower, repIncrement, keepScreenOn },
 *   selectedDayId,
 *   categories: [{ name, slot }],            // grupos musculares editables (ver muscleGroups.js)
 *   profile: { heightCm },
 *   measurements: [{ id, date, weight, waist, chest, arm, leg }],  // kg y cm; campos vacíos = null
 *   lastBackupAt, backupSnoozeUntil          // 'YYYY-MM-DD' o null; para recordar el respaldo
 * }
 */

import { DEFAULT_CATEGORIES, setCategories, guessMuscleGroup, norm } from './muscleGroups.js';

export const STORAGE_KEY = 'gimnasio_v2';
const LEGACY_KEY = 'musculacion_v1';

export const DEFAULT_SETTINGS = {
  mesocycleWeeks: 4,     // semanas por bloque antes de una semana de descarga
  deloadFactor: 0.55,    // fracción de peso que se mantiene en la semana de descarga
  incrementUpper: 2.5,   // kg que se suman al progresar en tren superior/torso
  incrementLower: 5,     // kg que se suman al progresar en tren inferior
  repIncrement: 1,       // reps que se suman cuando no se puede subir el peso (ej. peso corporal)
  keepScreenOn: true,    // pantalla encendida en 'Hoy' (Wake Lock API; si el navegador no la soporta, no hace nada)
};

function emptyState() {
  return {
    routines: [], activeRoutineId: null, logs: [], settings: { ...DEFAULT_SETTINGS }, selectedDayId: null,
    categories: DEFAULT_CATEGORIES.map(c => ({ ...c })), profile: { heightCm: null }, measurements: [],
    lastBackupAt: null, backupSnoozeUntil: null,
  };
}

/** Completa campos que se agregaron con el tiempo y activa las categorías del usuario. */
function normalizeState(st) {
  st.settings = { ...DEFAULT_SETTINGS, ...(st.settings || {}) };
  if (!Array.isArray(st.categories) || !st.categories.length) st.categories = DEFAULT_CATEGORIES.map(c => ({ ...c }));
  for (const c of st.categories) if (c.base === undefined) c.base = DEFAULT_CATEGORIES.find(d => d.name === c.name)?.base || null;
  st.profile = { heightCm: null, ...(st.profile || {}) };
  if (!Array.isArray(st.measurements)) st.measurements = [];
  if (st.lastBackupAt === undefined) st.lastBackupAt = null;
  if (st.backupSnoozeUntil === undefined) st.backupSnoozeUntil = null;
  setCategories(st.categories);
  reassignUnknownGroups(st);
  return st;
}

/**
 * Todo ejercicio o serie cuya categoría no existe (por ejemplo el viejo
 * "Otro", o una categoría borrada) se reasigna: por el nombre del
 * ejercicio, si no por el título del día, si no por la categoría más
 * común del día, y si no a la primera categoría.
 */
function reassignUnknownGroups(st) {
  const valid = new Set(st.categories.map(c => c.name));
  const first = st.categories[0].name;
  const byKey = new Map();
  for (const r of st.routines) {
    for (const day of r.days) {
      const counts = new Map();
      for (const ex of day.exercises) if (valid.has(ex.muscleGroup)) counts.set(ex.muscleGroup, (counts.get(ex.muscleGroup) || 0) + 1);
      const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      for (const ex of day.exercises) {
        if (!valid.has(ex.muscleGroup)) ex.muscleGroup = guessMuscleGroup(ex.name) || guessMuscleGroup(day.name) || dominant || first;
        byKey.set(normalizeName(ex.name), ex.muscleGroup);
      }
    }
  }
  for (const l of st.logs) {
    if (!valid.has(l.muscleGroup)) l.muscleGroup = byKey.get(l.exerciseKey) || guessMuscleGroup(l.exerciseName) || first;
  }
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
          muscleGroup: '', // se completa en normalizeState
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
        muscleGroup: ex ? ex.muscleGroup : '',
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
      const st = normalizeState(JSON.parse(raw));
      saveState(st);
      return st;
    }
  } catch (e) { /* localStorage corrupto o bloqueado: seguimos con estado vacío/migrado */ }

  const migrated = migrateLegacy();
  if (migrated) {
    normalizeState(migrated);
    saveState(migrated);
    return migrated;
  }
  return normalizeState(emptyState());
}

/* ---------------- Categorías: renombrar / borrar actualiza rutinas e historial ---------------- */

export function renameCategory(st, oldName, newName) {
  const cat = st.categories.find(c => c.name === oldName);
  if (!cat) return;
  cat.name = newName;
  for (const r of st.routines) for (const d of r.days) for (const ex of d.exercises) if (ex.muscleGroup === oldName) ex.muscleGroup = newName;
  for (const l of st.logs) if (l.muscleGroup === oldName) l.muscleGroup = newName;
  setCategories(st.categories);
}

export function deleteCategory(st, name, moveTo) {
  st.categories = st.categories.filter(c => c.name !== name);
  for (const r of st.routines) for (const d of r.days) for (const ex of d.exercises) if (ex.muscleGroup === name) ex.muscleGroup = moveTo;
  for (const l of st.logs) if (l.muscleGroup === name) l.muscleGroup = moveTo;
  setCategories(st.categories);
}

export function categoryUsage(st, name) {
  let exercises = 0;
  for (const r of st.routines) for (const d of r.days) for (const ex of d.exercises) if (ex.muscleGroup === name) exercises++;
  return { exercises, sets: st.logs.filter(l => l.muscleGroup === name).length };
}

export function categoryNameTaken(st, name, except = null) {
  return st.categories.some(c => c.name !== except && norm(c.name) === norm(name));
}

/* ---------------- Medidas corporales ---------------- */

export const MEASURE_FIELDS = [
  { key: 'weight', label: 'Peso', unit: 'kg' },
  { key: 'waist', label: 'Cintura', unit: 'cm' },
  { key: 'chest', label: 'Pecho', unit: 'cm' },
  { key: 'arm', label: 'Brazo', unit: 'cm' },
  { key: 'leg', label: 'Pierna', unit: 'cm' },
];

/** Guarda (o completa, si ya hay una del mismo día) una medición. */
export function upsertMeasurement(st, date, values) {
  let entry = st.measurements.find(m => m.date === date);
  if (!entry) {
    entry = { id: uid(), date };
    for (const f of MEASURE_FIELDS) entry[f.key] = null;
    st.measurements.push(entry);
  }
  for (const f of MEASURE_FIELDS) if (values[f.key] != null) entry[f.key] = values[f.key];
  st.measurements.sort((a, b) => a.date.localeCompare(b.date));
  return entry;
}

/* ---------------- Exportar a CSV (para analizar en Excel / Google Sheets) ---------------- */

/** Punto y coma + coma decimal + BOM: así lo abre bien Excel configurado en español. */
function toCsv(header, rows) {
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\ufeff' + [header, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export function exportMeasurementsCsv(st) {
  const h = st.profile.heightCm;
  const rows = st.measurements.map(m => [
    m.date, m.weight, m.waist, m.chest, m.arm, m.leg,
    h && m.weight ? Math.round((m.weight / ((h / 100) ** 2)) * 10) / 10 : null,
  ]);
  download(`medidas-${todayISO()}.csv`, toCsv(['Fecha', 'Peso (kg)', 'Cintura (cm)', 'Pecho (cm)', 'Brazo (cm)', 'Pierna (cm)', 'IMC'], rows), 'text/csv;charset=utf-8');
}

export function exportWorkoutsCsv(st) {
  const rows = st.logs.slice().sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts)
    .map(l => [l.date, l.exerciseName, l.muscleGroup, l.setNumber, l.weight, l.reps, l.phase === 'descarga' ? 'Descarga' : 'Carga']);
  download(`entrenamientos-${todayISO()}.csv`, toCsv(['Fecha', 'Ejercicio', 'Grupo muscular', 'Serie', 'Peso (kg)', 'Reps', 'Fase'], rows), 'text/csv;charset=utf-8');
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

/**
 * ¿Conviene recordarle al usuario que descargue un respaldo? Sin backend,
 * todo vive solo en este dispositivo — si el navegador borra el sitio o el
 * celular se pierde/rompe, sin respaldo no queda nada.
 */
export function needsBackupReminder(st) {
  const hasData = st.routines.length > 0 || st.logs.length > 0 || st.measurements.length > 0;
  if (!hasData) return false;
  if (st.backupSnoozeUntil && todayISO() < st.backupSnoozeUntil) return false;
  // recién empezando: esperamos a que haya algo mínimamente valioso antes de molestar
  if (!st.lastBackupAt) return st.logs.length >= 3 || st.measurements.length >= 1;
  return daysBetween(st.lastBackupAt, todayISO()) >= 14;
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
  return normalizeState(parsed);
}
