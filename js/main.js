import {
  loadState, saveState, uid, todayISO, normalizeName,
  getRoutine, getActiveRoutine, findExercise, exportBackup, importBackup, DEFAULT_SETTINGS,
  repsForSetIndex, repsSchemeLabel, parseRepsSchemeInput,
  renameCategory, deleteCategory, categoryUsage, categoryNameTaken,
  MEASURE_FIELDS, upsertMeasurement, exportMeasurementsCsv, exportWorkoutsCsv,
  needsBackupReminder,
} from './state.js';
import { getCategories, setCategories, muscleGroupClass, guessMuscleGroup, slotFor, freeSlot, MAX_CATEGORIES } from './muscleGroups.js';
import { extractTextFromDocx, parseRoutineText, fillMissingGroups, PASTE_PLACEHOLDER } from './parser.js';
import { weekInfo, nextDeloadDate, suggestForExercise, overallFatigue, cycleStartForWeek } from './coach.js';
import { restTimer, startRest, skipRest, addRestTime, resyncRest } from './timer.js';
import { icon } from './icons.js';
import { lineChart } from './charts.js';

let state = loadState();
let currentView = 'hoy';
/** progreso de series de hoy por ejercicio: { [exerciseId]: { setsLogged, weight, reps } } */
let todaySets = {};
let progressMode = 'grupo';
let progressGroup = null;
let progressExKey = null;
let routineWizard = null; // asistente de creación/edición de rutina
let modalView = null;     // 'settings' | null
let focusedExId = null;   // ejercicio que el usuario eligió hacer ahora (si no, el primero sin completar)
let catDeleting = null;   // índice de la categoría que se está por borrar (pide a dónde mover sus ejercicios)
let bodyForm = null;      // formulario de medidas en curso: { date, editingId, values: { weight: '78,4', ... } }
let bodyMetric = 'weight';
let editingLog = null; // id del log (serie) que se está editando o borrando

/** Se muestra en el diagnóstico para confirmar que el dispositivo tiene la última versión publicada. */
const APP_VERSION = '2026-09-25.7';

const WEEKDAY_LABELS =['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function persist() { saveState(state); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
/** 'YYYY-MM-DD' → '16/10/2026' */
function formatDate(iso) { const [y, m, d] = String(iso).split('-'); return d ? `${d}/${m}/${y}` : iso; }
function formatToday() { const d = new Date(); return `${WEEKDAY_LABELS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; }
function seriesVarFor(muscleGroup) { const slot = slotFor(muscleGroup) || 1; return `--series-${slot}`; }

/* ================================================================
   Datos derivados (cruzan rutinas: se agrupan por exerciseKey, no
   por el id del ejercicio dentro de una rutina puntual)
   ================================================================ */

/** Series de días anteriores: el entrenador sugiere en base a la última sesión completa, no a la serie que acabás de hacer hoy. */
function historyLogs() { const today = todayISO(); return state.logs.filter(l => l.date !== today); }
function logsForKey(key) { return state.logs.filter(l => l.exerciseKey === key); }
function lastWeightFor(key) {
  const entries = logsForKey(key).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  return entries.length ? entries[0].weight : null;
}
function maxWeightFor(key) {
  const entries = logsForKey(key);
  return entries.length ? Math.max(...entries.map(l => l.weight)) : 0;
}

/* ================================================================ Router ================================================================ */

function render() {
  document.getElementById('todayLabel').textContent = formatToday();
  document.querySelectorAll('nav.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === currentView));
  const main = document.getElementById('main');
  if (currentView === 'hoy') renderHoy(main);
  else if (currentView === 'rutinas') renderRutinas(main);
  else if (currentView === 'entrenador') renderEntrenador(main);
  else if (currentView === 'cuerpo') renderCuerpo(main);
  else renderProgreso(main);
  renderModal();
  renderRestBar();
  renderBackupBanner();
  syncWakeLock();
}

/** Banner para recordar el respaldo: sin backend, los datos viven solo en este dispositivo. */
function renderBackupBanner() {
  const host = document.getElementById('backupHost');
  if (!needsBackupReminder(state)) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="backup-banner">
    <div class="bb-text">${icon('download')}<span>${state.lastBackupAt ? 'Hace tiempo que no hacés un respaldo.' : 'Ya tenés datos cargados: convendría hacer un respaldo.'}</span></div>
    <div class="bb-actions">
      <button onclick="App.doExport()">Descargar</button>
      <button class="ghost" onclick="App.snoozeBackup()">Ahora no</button>
    </div>
  </div>`;
}

function switchTab(view) { currentView = view; render(); }

/* ---------------- Pantalla encendida durante el entreno (Wake Lock) ---------------- */

let wakeLock = null;
/**
 * Pide o libera el "wake lock" según corresponda: solo mientras se está en
 * 'Hoy', con la pestaña visible y la opción activada. El navegador libera
 * el wake lock solo al ocultar la pestaña, así que hay que volver a
 * pedirlo al regresar (ver el listener de visibilitychange, más abajo).
 */
async function syncWakeLock() {
  const wants = currentView === 'hoy' && state.settings.keepScreenOn && document.visibilityState === 'visible' && 'wakeLock' in navigator;
  if (wants && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; /* el navegador puede negarlo (batería baja, pestaña sin foco, etc.); no es crítico */ }
  } else if (!wants && wakeLock) {
    try { await wakeLock.release(); } catch (e) { /* ya liberado */ }
    wakeLock = null;
  }
}

/* ================================================================ Vista: Hoy ================================================================ */

function getSelectedDay() {
  const routine = getActiveRoutine(state);
  if (!routine) return null;
  return routine.days.find(d => d.id === state.selectedDayId) || routine.days[0] || null;
}

/** Número con coma decimal, como se escribe en Argentina (42,5). */
function fmtNum(n) { return String(n).replace('.', ','); }
function formatKg(w) { return w > 0 ? `${fmtNum(w)} kg` : 'Peso corporal'; }

function emptyState(iconName, title, text, actionHtml = '') {
  return `<div class="empty"><div class="empty-icon">${icon(iconName)}</div><h3>${title}</h3><p>${text}</p>${actionHtml}</div>`;
}

/** "Día 1 - Pecho Hombro Triceps" → pestaña "Día 1", título "Pecho Hombro Triceps". */
function dayShortLabel(day, idx) {
  const m = day.name.match(/^(d[ií]a\s*[a-z0-9]+)/i);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : `Día ${idx + 1}`;
}
function dayTitle(day) {
  const parts = day.name.split(/\s+[-–—:]\s+/);
  return parts.length > 1 ? parts.slice(1).join(' · ') : day.name;
}

/**
 * Agrupa los ejercicios de un día en "unidades": una superserie (2+
 * ejercicios contiguos con el mismo supersetGroup) es una unidad; el
 * resto son unidades de un solo ejercicio. Se agrupa por tramos
 * contiguos, no por id de grupo en todo el día, para que desvincular un
 * ejercicio del medio no vuelva a unir accidentalmente a los de los
 * costados.
 */
function buildUnits(exercises) {
  const units = [];
  let i = 0;
  while (i < exercises.length) {
    const ex = exercises[i];
    let j = i + 1;
    if (ex.supersetGroup) while (j < exercises.length && exercises[j].supersetGroup === ex.supersetGroup) j++;
    units.push(exercises.slice(i, j));
    i = j;
  }
  return units;
}

/** El ejercicio de una superserie que sigue: el de menos series hechas (a igualdad, el primero en el orden). */
function nextActiveInGroup(group) {
  const active = group.filter(e => (todaySets[e.id]?.setsLogged ?? 0) < e.sets);
  if (!active.length) return null;
  const minLogged = Math.min(...active.map(e => todaySets[e.id].setsLogged));
  return active.find(e => todaySets[e.id].setsLogged === minLogged) || active[0];
}

/** Series ya registradas hoy para un ejercicio: así el progreso del día sobrevive a cerrar la app. */
function todayLogsFor(dayId, exId) {
  const today = todayISO();
  return state.logs
    .filter(l => l.date === today && l.dayId === dayId && l.exerciseId === exId)
    .sort((a, b) => a.setNumber - b.setNumber || a.ts - b.ts);
}

function renderHoy(main) {
  const routine = getActiveRoutine(state);
  if (!routine) {
    main.innerHTML = emptyState('dumbbell', 'Arranquemos',
      'Cargá la rutina que te armó tu entrenador y empezá a registrar tus series.',
      `<button class="btn-primary" onclick="App.switchTab('rutinas')">${icon('upload')} Cargar mi rutina</button>`);
    return;
  }
  const day = getSelectedDay();
  const info = weekInfo(routine, todayISO(), state.settings);

  const rows = day.exercises.map((ex) => {
    const key = normalizeName(ex.name);
    const plannedReps = ex.repsScheme[ex.repsScheme.length - 1]; // la serie más pesada del esquema, la que manda para progresar
    const suggestion = suggestForExercise({ exerciseName: ex.name, muscleGroup: ex.muscleGroup, plannedReps }, historyLogs(), state.settings, info.phase);
    const logged = todayLogsFor(day.id, ex.id);
    if (!todaySets[ex.id]) {
      const lastToday = logged[logged.length - 1];
      const defaultWeight = lastToday ? lastToday.weight
        : suggestion.suggestedWeight != null ? suggestion.suggestedWeight : (lastWeightFor(key) ?? 0);
      todaySets[ex.id] = { setsLogged: logged.length, weight: defaultWeight, reps: repsForSetIndex(ex, logged.length), pr: null };
    }
    const prog = todaySets[ex.id];
    return { ex, key, suggestion, logged, prog, done: prog.setsLogged >= ex.sets };
  });

  const totalSets = day.exercises.reduce((a, ex) => a + ex.sets, 0);
  const doneSets = rows.reduce((a, r) => a + Math.min(r.prog.setsLogged, r.ex.sets), 0);
  const pct = totalSets ? Math.round((doneSets / totalSets) * 100) : 0;
  const rowsById = new Map(rows.map(r => [r.ex.id, r]));

  // unidades del día: una superserie completa (2+ ejercicios) cuenta como una sola unidad al elegir "el actual"
  const units = buildUnits(day.exercises).map(exs => exs.map(ex => rowsById.get(ex.id)));
  const unitDone = (u) => u.every(r => r.done);
  const activeRowOfUnit = (u) => {
    if (u.length === 1) return u[0].done ? null : u[0];
    const active = u.filter(r => !r.done);
    if (!active.length) return null;
    const minLogged = Math.min(...active.map(r => r.prog.setsLogged));
    return active.find(r => r.prog.setsLogged === minLogged) || active[0];
  };
  const focusedUnit = focusedExId ? units.find(u => u.some(r => r.ex.id === focusedExId) && !unitDone(u)) : null;
  const currentUnit = focusedUnit || units.find(u => !unitDone(u)) || null;
  const current = currentUnit ? activeRowOfUnit(currentUnit) : null;

  let html = `<section class="session-hero">
    <div class="day-tabs" role="tablist">
      ${routine.days.map((d, i) => `<button class="day-tab ${d.id === day.id ? 'active' : ''}" role="tab" aria-selected="${d.id === day.id}" onclick="App.selectDay('${d.id}')">${escapeHtml(dayShortLabel(d, i))}</button>`).join('')}
    </div>
    <div class="hero-row">
      <div>
        <h2 class="hero-title">${escapeHtml(dayTitle(day))}</h2>
        <div class="hero-sub">${day.exercises.length} ejercicios · ${escapeHtml(routine.name)}</div>
      </div>
      <span class="phase-pill ${info.phase}">Sem ${info.weekInBlock}/${state.settings.mesocycleWeeks} · ${info.phase === 'descarga' ? 'Descarga' : 'Carga'}</span>
    </div>
    ${totalSets ? `<div class="progress-wrap">
      <div class="progress-label"><span>Progreso de hoy</span><span><b>${doneSets}</b> de ${totalSets} series</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>` : ''}
  </section>`;

  if (!day.exercises.length) {
    html += emptyState('list', 'Día sin ejercicios', 'Agregalos desde la pestaña Rutinas → Editar.');
  } else if (!current) {
    html += `<div class="day-done"><h3>¡Día completo!</h3>Registraste las ${totalSets} series. Buen entrenamiento.</div>`;
  }

  const partnersById = new Map();
  for (const u of units) {
    if (u.length < 2) continue;
    for (const r of u) partnersById.set(r.ex.id, u.filter(o => o !== r).map(o => o.ex.name).join(' + '));
  }

  rows.forEach((r, i) => { html += exerciseCardHtml(r, i, r === current, day.id, partnersById.get(r.ex.id) || null); });
  main.innerHTML = html;
}

function exerciseCardHtml(r, index, isCurrent, dayId, partnersLabel) {
  const { ex, key, suggestion, logged, prog, done } = r;
  const last = lastWeightFor(key);
  const state_ = done ? 'done' : isCurrent ? 'current' : '';
  const ssTag = partnersLabel ? `<div class="ss-tag">${icon('link')} Superserie con ${escapeHtml(partnersLabel)}</div>` : '';
  const notesLine = ex.notes ? `<div class="ex-notes">${icon('paste')}${escapeHtml(ex.notes)}</div>` : '';

  const pills = Array.from({ length: ex.sets }, (_, s) => {
    const l = logged[s];
    if (l) return `<button class="set-pill done" onclick="event.stopPropagation(); App.editSetOpen('${l.id}')"><span class="set-n">S${s + 1}</span><b>${l.weight > 0 ? fmtNum(l.weight) : '—'}</b><small>${l.weight > 0 ? 'kg ' : ''}× ${l.reps}</small></button>`;
    const cls = isCurrent && s === prog.setsLogged ? 'current' : '';
    return `<span class="set-pill ${cls}"><span class="set-n">S${s + 1}</span><b>${repsForSetIndex(ex, s)}</b><small>reps</small></span>`;
  }).join('');

  const head = `<div class="ex-head">
      <span class="ex-index">${done ? icon('check') : index + 1}</span>
      <div class="ex-title">
        <p class="ex-name">${escapeHtml(ex.name)}</p>
        <div class="ex-sub">
          <span class="mg-chip ${muscleGroupClass(ex.muscleGroup)}">${escapeHtml(ex.muscleGroup)}</span>
          <span class="meta">${icon('clock')}${ex.restSeconds}s</span>
          ${last != null && !done ? `<span class="meta">${icon('history')}${formatKg(last)}</span>` : ''}
        </div>
      </div>
    </div>`;
  const prBadge = prog.pr ? `<div class="pr-badge">${icon('trophy')} Nuevo récord: ${formatKg(prog.pr)}</div>` : '';

  if (!isCurrent) {
    const tap = done ? '' : ` onclick="App.focusExercise('${ex.id}')" style="cursor:pointer"`;
    return `<article class="ex-card ${state_}"${tap}>${head}${ssTag}${notesLine}<div class="set-track">${pills}</div>${prBadge}</article>`;
  }

  const sw = suggestion.suggestedWeight;
  const coach = sw != null
    ? `<div class="coach-line">${icon('bolt')}
        <div class="coach-text">Sugerido: <b>${formatKg(sw)}</b><small>${escapeHtml(suggestion.note)}</small></div>
        ${sw !== prog.weight ? `<button class="btn-chip" onclick="App.useSuggestion('${ex.id}', ${sw})">Usar</button>` : ''}
      </div>`
    : `<div class="coach-line">${icon('bolt')}<div class="coach-text"><small style="margin:0">${escapeHtml(suggestion.note)}</small></div></div>`;

  return `<article class="ex-card current" id="ex-${ex.id}">
    ${head}
    ${ssTag}
    ${notesLine}
    <div class="set-track">${pills}</div>
    ${coach}
    <div class="input-grid">
      <div class="stepper">
        <div class="stepper-label">Peso · kg</div>
        <div class="stepper-row">
          <button class="stepper-btn" aria-label="Bajar peso" onclick="App.adjustWeight('${ex.id}', -2.5)">−</button>
          <input class="stepper-value" type="text" inputmode="decimal" autocomplete="off" aria-label="Peso en kg" value="${fmtNum(prog.weight)}" onfocus="this.select()" oninput="App.setWeight('${ex.id}', this.value)">
          <button class="stepper-btn" aria-label="Subir peso" onclick="App.adjustWeight('${ex.id}', 2.5)">+</button>
        </div>
      </div>
      <div class="stepper">
        <div class="stepper-label">Reps</div>
        <div class="stepper-row">
          <button class="stepper-btn" aria-label="Menos reps" onclick="App.adjustReps('${ex.id}', -1)">−</button>
          <input class="stepper-value" type="text" inputmode="numeric" autocomplete="off" aria-label="Repeticiones" value="${prog.reps}" onfocus="this.select()" oninput="App.setReps('${ex.id}', this.value)">
          <button class="stepper-btn" aria-label="Más reps" onclick="App.adjustReps('${ex.id}', 1)">+</button>
        </div>
      </div>
    </div>
    <button class="btn-primary" onclick="App.logSet('${ex.id}', '${dayId}')">${icon('check')} Registrar serie ${prog.setsLogged + 1} de ${ex.sets}</button>
    ${prBadge}
  </article>`;
}

/** Timer de descanso: se dibuja aparte (no redibuja la pantalla, así no se pierde lo que estás tipeando). */
function renderRestBar() {
  const host = document.getElementById('restHost');
  if (!restTimer.active) { host.innerHTML = ''; return; }
  const m = Math.floor(restTimer.secondsLeft / 60);
  const s = String(restTimer.secondsLeft % 60).padStart(2, '0');
  const pct = (restTimer.secondsLeft / restTimer.total) * 100;
  const existing = host.querySelector('.rest-float');
  if (existing) {
    existing.querySelector('.rest-time').textContent = `${m}:${s}`;
    existing.querySelector('.rest-progress').style.width = `${pct}%`;
    return;
  }
  host.innerHTML = `<div class="rest-float" role="timer" aria-live="off">
    <div class="rest-progress" style="width:${pct}%"></div>
    <div class="rest-inner">
      <span class="rest-time">${m}:${s}</span>
      <span class="rest-label">Descanso<b>${escapeHtml(restTimer.exerciseName)}</b></span>
      <button onclick="App.addRest(15)">+15s</button>
      <button class="primary" onclick="App.skipRest()">Saltar</button>
    </div>
  </div>`;
}

/* ---------------- Editar/borrar una serie ya registrada ---------------- */

function editSetOpen(logId) { editingLog = logId; modalView = 'editSet'; render(); }

function editSetModalHtml() {
  const log = state.logs.find(l => l.id === editingLog);
  if (!log) { editingLog = null; modalView = null; return ''; }
  return `<div class="modal-overlay" onclick="if(event.target===this) App.closeModal()">
    <div class="modal-box">
      <h2>Editar serie</h2>
      <p class="hint" style="margin-top:-10px">${escapeHtml(log.exerciseName)} · serie ${log.setNumber} · ${formatDate(log.date)}</p>
      <div class="field"><label>Peso (kg)</label><input type="text" inputmode="decimal" id="editSetWeight" value="${fmtNum(log.weight)}"></div>
      <div class="field"><label>Repeticiones</label><input type="text" inputmode="numeric" id="editSetReps" value="${log.reps}"></div>
      <button class="btn-danger" onclick="App.deleteEditedSet()">${icon('trash')} Borrar esta serie</button>
      <div class="modal-close-row">
        <button class="btn-secondary" style="width:auto;padding:9px 20px" onclick="App.closeModal()">Cancelar</button>
        <button class="btn-primary" style="width:auto;padding:9px 20px" onclick="App.saveEditedSet()">Guardar</button>
      </div>
    </div>
  </div>`;
}

/** Reordena las series de un ejercicio en un día para que queden 1..N sin huecos, tras borrar una del medio. */
function renumberSets(date, dayId, exId) {
  const logs = state.logs.filter(l => l.date === date && l.dayId === dayId && l.exerciseId === exId).sort((a, b) => a.setNumber - b.setNumber || a.ts - b.ts);
  logs.forEach((l, i) => { l.setNumber = i + 1; });
  return logs.length;
}

/** El contador de series de hoy (cacheado en todaySets) se recalcula tras borrar una serie del día. */
function syncTodaySetsAfterEdit(dayId, exId, count) {
  const prog = todaySets[exId];
  if (!prog) return;
  const ex = findExercise(state, getActiveRoutine(state)?.id, dayId, exId);
  prog.setsLogged = count;
  if (ex) prog.reps = repsForSetIndex(ex, count);
}

function saveEditedSet() {
  const log = state.logs.find(l => l.id === editingLog);
  if (!log) { closeModal(); return; }
  const weight = parseDecimal(document.getElementById('editSetWeight').value) ?? 0;
  const reps = parseInt(document.getElementById('editSetReps').value, 10);
  if (!Number.isFinite(reps) || reps <= 0) { alert('Las repeticiones tienen que ser un número mayor a 0.'); return; }
  log.weight = Math.max(0, weight);
  log.reps = reps;
  editingLog = null; modalView = null;
  persist(); render();
}

function deleteEditedSet() {
  const log = state.logs.find(l => l.id === editingLog);
  if (!log) { closeModal(); return; }
  if (!confirm(`¿Borrar la serie ${log.setNumber} de "${log.exerciseName}" (${formatDate(log.date)})?`)) return;
  const { date, dayId, exerciseId } = log;
  state.logs = state.logs.filter(l => l.id !== log.id);
  const count = renumberSets(date, dayId, exerciseId);
  if (date === todayISO()) syncTodaySetsAfterEdit(dayId, exerciseId, count);
  editingLog = null; modalView = null;
  persist(); render();
}

function selectDay(id) { state.selectedDayId = id; todaySets = {}; focusedExId = null; persist(); render(); }
function focusExercise(id) { focusedExId = id; render(); document.getElementById(`ex-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
function adjustWeight(exId, delta) { todaySets[exId].weight = Math.max(0, Math.round((todaySets[exId].weight + delta) * 2) / 2); render(); }
function adjustReps(exId, delta) { todaySets[exId].reps = Math.max(0, todaySets[exId].reps + delta); render(); }
function useSuggestion(exId, weight) { todaySets[exId].weight = weight; render(); }
/** Acepta coma o punto decimal ("42,5" o "42.5"); no redibuja para no interrumpir lo que se está escribiendo. */
function setWeight(exId, value) { todaySets[exId].weight = Math.max(0, parseFloat(String(value).replace(',', '.')) || 0); }
function setReps(exId, value) { todaySets[exId].reps = Math.max(0, parseInt(value, 10) || 0); }

/**
 * Registrar una serie. Si el ejercicio es parte de una superserie (2+
 * ejercicios "combinados"), no hay descanso hasta terminar la ronda
 * completa (una serie de cada uno); recién ahí se descansa, como se
 * entrena en la práctica. Fuera de una superserie, el descanso es el de
 * siempre, entre cada serie del mismo ejercicio.
 */
function logSet(exId, dayId) {
  const routine = getActiveRoutine(state);
  const day = routine.days.find(d => d.id === dayId);
  const ex = day.exercises.find(e => e.id === exId);
  const key = normalizeName(ex.name);
  const prog = todaySets[exId];
  const wasMax = maxWeightFor(key);
  const info = weekInfo(routine, todayISO(), state.settings);

  const group = ex.supersetGroup ? day.exercises.filter(e => e.supersetGroup === ex.supersetGroup) : [];
  const isGroup = group.length > 1;
  // ¿exId es el último que le faltaba hacer su serie en esta ronda? (antes de registrar esta)
  const activeBefore = isGroup ? group.filter(e => (todaySets[e.id]?.setsLogged ?? 0) < e.sets) : [];
  const closesRound = !isGroup || (activeBefore.length && activeBefore[activeBefore.length - 1].id === exId);

  state.logs.push({
    id: uid(), ts: Date.now(), date: todayISO(), routineId: routine.id, dayId,
    exerciseId: exId, exerciseName: ex.name, exerciseKey: key, muscleGroup: ex.muscleGroup,
    weight: prog.weight, reps: prog.reps, setNumber: prog.setsLogged + 1,
    weekNumber: info.weekNumber, weekInBlock: info.weekInBlock, phase: info.phase,
  });
  prog.setsLogged++;
  if (prog.weight > 0 && prog.weight > wasMax) prog.pr = prog.weight;
  if (prog.setsLogged < ex.sets) prog.reps = repsForSetIndex(ex, prog.setsLogged); // la próxima serie muestra su propia meta de reps (esquema piramidal)
  persist();

  let advancedUnit = false;
  if (isGroup) {
    if (closesRound) {
      // se completó la ronda: ahora sí, a descansar. Si la superserie no terminó, seguimos enfocados en
      // ella (para su próxima ronda) aunque haya una unidad anterior sin terminar (la saltamos a propósito).
      advancedUnit = group.every(e => todaySets[e.id].setsLogged >= e.sets);
      focusedExId = advancedUnit ? null : ex.id;
      startRest(ex.restSeconds, ex.name, renderRestBar);
    } else {
      // sigue la ronda: se pasa directo al otro ejercicio de la superserie, sin descanso
      focusedExId = nextActiveInGroup(group)?.id ?? null;
      skipRest(renderRestBar);
    }
  } else {
    const finished = prog.setsLogged >= ex.sets;
    if (finished) { focusedExId = null; skipRest(renderRestBar); advancedUnit = true; }
    else startRest(ex.restSeconds, ex.name, renderRestBar);
  }
  render();
  if (advancedUnit) document.querySelector('.ex-card.current')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ================================================================ Vista: Rutinas ================================================================ */

function summaryChipsForRoutine(routine) {
  const groups = new Set();
  for (const d of routine.days) for (const e of d.exercises) groups.add(e.muscleGroup);
  return Array.from(groups).map(g => `<span class="mg-chip ${muscleGroupClass(g)}">${escapeHtml(g)}</span>`).join('');
}

function renderRutinas(main) {
  if (routineWizard) { renderWizard(main); return; }

  let html = '';
  if (!state.routines.length) {
    html += emptyState('list', 'Sin rutinas todavía',
      'Subí el Word que te pasó tu entrenador, pegá el texto o armala a mano. Cuando te cambien la rutina, cargás una nueva y tu progreso se mantiene.');
  } else {
    html += `<h2 class="section-title">Tus rutinas</h2>`;
  }

  for (const r of state.routines) {
    const active = r.id === state.activeRoutineId;
    const exCount = r.days.reduce((a, d) => a + d.exercises.length, 0);
    html += `<div class="card routine-card ${active ? 'active' : ''}">
      ${active ? '<span class="badge-active">Activa</span>' : ''}
      <h3>${escapeHtml(r.name)}</h3>
      <p class="sub">Desde el ${formatDate(r.startDate)} · ${r.days.length} días · ${exCount} ejercicios</p>
      <div class="chip-row">${summaryChipsForRoutine(r)}</div>
      <div class="btn-row">
        ${active ? '' : `<button class="btn-secondary" onclick="App.activateRoutine('${r.id}')">Activar</button>`}
        <button class="btn-secondary" onclick="App.editRoutine('${r.id}')">Editar</button>
      </div>
      <div class="card-footer"><button class="btn-danger" onclick="App.deleteRoutine('${r.id}')">Eliminar rutina</button></div>
    </div>`;
  }

  html += `<button class="btn-primary" style="margin-top:4px" onclick="App.startNewRoutine()">${icon('plus')} Nueva rutina</button>
    <p class="hint" style="text-align:center;margin-top:12px">El historial se guarda por ejercicio: aunque cambies de rutina cada 3 meses, tu progreso sigue.</p>
    <h2 class="section-title">Categorías</h2>
    <div class="card">
      <div class="chip-row">${getCategories().map(c => `<span class="mg-chip ${muscleGroupClass(c.name)}">${escapeHtml(c.name)}</span>`).join('')}</div>
      <button class="btn-secondary" onclick="App.openCategories()">Agregar o editar categorías</button>
    </div>`;
  main.innerHTML = html;
}

function startNewRoutine() {
  routineWizard = { step: 'method', editingId: null, name: `Rutina ${state.routines.length + 1}`, startDate: todayISO(), days: [], warnings: [] };
  render();
}
function editRoutine(id) {
  const r = getRoutine(state, id);
  routineWizard = { step: 'review', editingId: id, name: r.name, startDate: r.startDate, days: JSON.parse(JSON.stringify(r.days)), warnings: [] };
  render();
}
function cancelWizard() { routineWizard = null; render(); }
function activateRoutine(id) {
  state.activeRoutineId = id;
  const r = getRoutine(state, id);
  state.selectedDayId = r.days[0]?.id || null;
  todaySets = {};
  persist(); render();
}
function deleteRoutine(id) {
  if (!confirm('¿Eliminar esta rutina? El historial de series ya registradas no se borra.')) return;
  state.routines = state.routines.filter(r => r.id !== id);
  if (state.activeRoutineId === id) {
    state.activeRoutineId = state.routines[0]?.id || null;
    state.selectedDayId = state.routines[0]?.days[0]?.id || null;
  }
  persist(); render();
}

function chooseMethod(method) {
  if (method === 'manual') {
    routineWizard.days = [{ id: uid(), name: 'Día 1', exercises: [] }];
    routineWizard.step = 'review';
  } else {
    routineWizard.step = method; // 'upload' | 'paste'
  }
  render();
}

async function handleDocxFile(input) {
  const file = input.files[0];
  if (!file) return;
  const box = document.getElementById('importStatus');
  if (box) box.textContent = 'Leyendo el archivo…';
  try {
    const text = await extractTextFromDocx(file);
    const { days, warnings } = parseRoutineText(text);
    routineWizard.days = days;
    routineWizard.warnings = warnings;
    routineWizard.step = 'review';
    render();
  } catch (e) {
    if (box) box.textContent = e.message || 'No se pudo leer el archivo. Probá pegando el texto de la rutina.';
  }
}

function handlePasteText() {
  const text = document.getElementById('pasteArea').value;
  const { days, warnings } = parseRoutineText(text);
  routineWizard.days = days;
  routineWizard.warnings = warnings;
  routineWizard.step = 'review';
  render();
}

function renderWizard(main) {
  const w = routineWizard;
  if (w.step === 'method') {
    const method = (key, iconName, title, text) => `<button class="method-btn" onclick="App.chooseMethod('${key}')">
      <span class="method-icon">${icon(iconName)}</span><span><b>${title}</b><span>${text}</span></span></button>`;
    main.innerHTML = `<h2 class="section-title">Nueva rutina</h2>
      <div class="method-list">
        ${method('upload', 'upload', 'Subir archivo Word', 'El .docx que te pasó tu entrenador. Se lee en tu celular, no se sube a ningún lado.')}
        ${method('paste', 'paste', 'Pegar el texto', 'Copiá la rutina de un mensaje o nota. Funciona sin conexión.')}
        ${method('manual', 'plus', 'Crearla a mano', 'Agregá días y ejercicios uno por uno.')}
      </div>
      <button class="btn-secondary" onclick="App.cancelWizard()">Cancelar</button>`;
    return;
  }
  if (w.step === 'upload') {
    main.innerHTML = `<h2 class="section-title">Subir rutina en Word</h2>
      <p class="hint">Es gratis: el archivo se lee en tu propio navegador (no se sube a ningún servidor). Funciona con .docx.</p>
      <div class="dropzone">
        Elegí tu archivo .docx
        <input type="file" accept=".docx" onchange="App.handleDocxFile(this)">
        <div id="importStatus" class="hint" style="margin-top:8px"></div>
      </div>
      <button class="btn-danger" onclick="App.cancelWizard()">Cancelar</button>`;
    return;
  }
  if (w.step === 'paste') {
    main.innerHTML = `<h2 class="section-title">Pegar la rutina</h2>
      <p class="hint">Un ejercicio por línea, con el formato "Ejercicio 4x10 descanso 90s" (también entiende pirámides: "4x10-8-8-6"). Los encabezados de día ("Día 1", "Lunes", ...) separan los días.</p>
      <textarea class="routine-paste" id="pasteArea" placeholder="${escapeHtml(PASTE_PLACEHOLDER)}"></textarea>
      <button class="btn-primary" style="margin:10px 0" onclick="App.handlePasteText()">Analizar texto</button>
      <button class="btn-danger" onclick="App.cancelWizard()">Cancelar</button>`;
    return;
  }
  // step === 'review'
  let html = `<h2 class="section-title">${w.editingId ? 'Editar rutina' : 'Revisar rutina'}</h2>`;
  if (w.warnings.length) {
    html += w.warnings.map(msg => `<div class="parse-warning">${escapeHtml(msg)}</div>`).join('');
  }
  html += `<label class="field-label">Nombre de la rutina</label>
    <input name="routine-name" value="${escapeHtml(w.name)}" oninput="App.wizardSetName(this.value)">
    <label class="field-label">Fecha de inicio</label>
    <input name="routine-date" type="date" value="${w.startDate}" oninput="App.wizardSetDate(this.value)">`;

  for (const day of w.days) {
    html += `<div class="day-block">
      <div class="day-block-head">
        <input value="${escapeHtml(day.name)}" onchange="App.wizardRenameDay('${day.id}', this.value)">
        <button class="icon-btn" onclick="App.wizardRemoveDay('${day.id}')">✕ día</button>
      </div>`;
    day.exercises.forEach((ex, exIdx) => {
      const prev = day.exercises[exIdx - 1];
      const linked = exIdx > 0 && ex.supersetGroup && prev.supersetGroup === ex.supersetGroup;
      html += `<div class="ex-row">
        <input placeholder="Ejercicio" value="${escapeHtml(ex.name)}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','name',this.value)">
        <select onchange="App.wizardUpdateEx('${day.id}','${ex.id}','muscleGroup',this.value)">
          ${getCategories().map(c => `<option value="${escapeHtml(c.name)}" ${c.name === ex.muscleGroup ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <input type="number" title="series" value="${ex.sets}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','sets',this.value)">
        <input type="text" title="reps (ej: 10 o 10-8-8-6)" placeholder="reps" value="${repsSchemeLabel(ex)}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','repsScheme',this.value)">
        <input type="number" title="descanso (s)" value="${ex.restSeconds}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','restSeconds',this.value)">
        <button class="icon-btn" onclick="App.wizardRemoveEx('${day.id}','${ex.id}')">✕</button>
      </div>
      <div class="ex-extra">
        ${exIdx > 0 ? `<button class="ss-toggle ${linked ? 'active' : ''}" onclick="App.wizardToggleSuperset('${day.id}','${ex.id}')">${icon('link')} ${linked ? 'Superserie con la anterior' : 'Vincular con la anterior'}</button>` : ''}
        <input class="ex-notes-input" placeholder="Notas (opcional): agarre, banda, altura del asiento…" value="${escapeHtml(ex.notes || '')}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','notes',this.value)">
      </div>`;
    });
    html += `<button class="add-ex-btn" onclick="App.wizardAddExercise('${day.id}')">+ Agregar ejercicio</button></div>`;
  }
  html += `<button class="add-day-btn" onclick="App.wizardAddDay()">+ Agregar día</button>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn-danger" onclick="App.cancelWizard()">Cancelar</button>
      <button class="btn-primary" onclick="App.saveWizard()">Guardar rutina</button>
    </div>`;
  main.innerHTML = html;
}

function wizardSetName(v) { routineWizard.name = v; }
function wizardSetDate(v) { routineWizard.startDate = v; }
function wizardAddDay() { routineWizard.days.push({ id: uid(), name: `Día ${routineWizard.days.length + 1}`, exercises: [] }); render(); }
function wizardRemoveDay(id) { routineWizard.days = routineWizard.days.filter(d => d.id !== id); render(); }
function wizardRenameDay(id, name) { routineWizard.days.find(d => d.id === id).name = name; }
function wizardAddExercise(dayId) {
  const day = routineWizard.days.find(d => d.id === dayId);
  // groupAuto: la categoría se sigue adivinando por el nombre hasta que el usuario elija una a mano
  day.exercises.push({ id: uid(), name: '', muscleGroup: guessMuscleGroup(day.name) || getCategories()[0].name, groupAuto: true, sets: 4, repsScheme: [10], restSeconds: 90, notes: '', supersetGroup: null });
  render();
}
function wizardRemoveEx(dayId, exId) {
  const day = routineWizard.days.find(d => d.id === dayId);
  day.exercises = day.exercises.filter(e => e.id !== exId);
  render();
}
function wizardUpdateEx(dayId, exId, field, value) {
  const ex = routineWizard.days.find(d => d.id === dayId).exercises.find(e => e.id === exId);
  if (field === 'name') {
    ex.name = value;
    const guess = ex.groupAuto && guessMuscleGroup(value);
    if (guess && guess !== ex.muscleGroup) { ex.muscleGroup = guess; render(); }
  } else if (field === 'muscleGroup') { ex.muscleGroup = value; ex.groupAuto = false; }
  else if (field === 'repsScheme') ex.repsScheme = parseRepsSchemeInput(value);
  else if (field === 'notes') ex.notes = value;
  else ex[field] = parseFloat(value) || 0;
}

/**
 * Vincula (o desvincula) un ejercicio con el anterior en el mismo día,
 * para armar (o deshacer) una superserie a mano. Si el anterior ya
 * estaba en un grupo, este se suma al mismo; encadenar de a uno permite
 * armar trisets. Al desvincular, si al grupo le queda un solo ejercicio,
 * se limpia entero (ya no es "superserie" de uno solo).
 */
function wizardToggleSuperset(dayId, exId) {
  const day = routineWizard.days.find(d => d.id === dayId);
  const idx = day.exercises.findIndex(e => e.id === exId);
  if (idx <= 0) return;
  const prev = day.exercises[idx - 1];
  const cur = day.exercises[idx];
  if (cur.supersetGroup && cur.supersetGroup === prev.supersetGroup) {
    const groupId = cur.supersetGroup;
    cur.supersetGroup = null;
    const rest = day.exercises.filter(e => e.supersetGroup === groupId);
    if (rest.length < 2) rest.forEach(e => { e.supersetGroup = null; });
  } else {
    const groupId = prev.supersetGroup || uid();
    prev.supersetGroup = groupId;
    cur.supersetGroup = groupId;
  }
  render();
}

function saveWizard() {
  const w = routineWizard;
  if (!w.name.trim()) { alert('Ponele un nombre a la rutina.'); return; }
  const cleanDays = w.days.map(d => ({ ...d, exercises: d.exercises.filter(e => e.name.trim()).map(({ groupAuto, ...e }) => e) }));
  cleanDays.forEach(fillMissingGroups);

  if (w.editingId) {
    const r = getRoutine(state, w.editingId);
    r.name = w.name.trim(); r.startDate = w.startDate; r.days = cleanDays;
  } else {
    const routine = { id: uid(), name: w.name.trim(), startDate: w.startDate, createdAt: Date.now(), source: 'wizard', days: cleanDays };
    state.routines.push(routine);
    state.activeRoutineId = routine.id;
    state.selectedDayId = routine.days[0]?.id || null;
    todaySets = {};
  }
  persist();
  routineWizard = null;
  render();
}

/* ================================================================ Vista: Entrenador ================================================================ */

function renderEntrenador(main) {
  const routine = getActiveRoutine(state);
  if (!routine) { main.innerHTML = emptyState('trend', 'Tu entrenador', 'Cargá una rutina y te armo un plan de progresión con semanas de carga y de descarga.'); return; }

  const info = weekInfo(routine, todayISO(), state.settings);
  const deload = nextDeloadDate(routine, state.settings, todayISO());
  const weeks = state.settings.mesocycleWeeks;

  const perDay = routine.days.map(day => ({
    day,
    items: day.exercises.map(ex => ({
      ex,
      s: suggestForExercise({ exerciseName: ex.name, muscleGroup: ex.muscleGroup, plannedReps: ex.repsScheme[ex.repsScheme.length - 1] }, historyLogs(), state.settings, info.phase),
    })),
  }));
  const overall = overallFatigue(perDay.flatMap(d => d.items.map(i => i.s)));

  const segs = Array.from({ length: weeks }, (_, i) => {
    const w = i + 1;
    const cls = [w < info.weekInBlock ? 'past' : '', w === info.weekInBlock ? 'now' : '', w === weeks ? 'deload' : ''].join(' ');
    return `<button class="week-seg ${cls}" aria-pressed="${w === info.weekInBlock}" onclick="App.setCurrentWeek(${w})"><div class="bar"></div><span>${w === weeks ? 'Descarga' : `Sem ${w}`}</span></button>`;
  }).join('');

  let html = `<div class="card coach-hero" style="margin-top:4px">
      <span class="phase-pill ${info.phase}">${icon(info.phase === 'descarga' ? 'flag' : 'bolt')} ${info.phase === 'descarga' ? 'Semana de descarga' : 'Semana de carga'}</span>
      <div class="week-track">${segs}</div>
      <p class="hint" style="margin-top:0">¿No coincide con tu entrenamiento? Tocá la semana en la que estás.</p>
      <p class="hint" style="margin-bottom:0">Bloque ${info.blockNumber} · semana ${info.weekInBlock} de ${weeks}.
        ${info.phase === 'carga' ? `Próxima descarga: <b>${formatDate(deload)}</b>.` : 'Bajá la intensidad y priorizá recuperar.'}</p>
      <div class="fatigue-meter"><span class="fatigue-dot ${overall.level.replace(' ', '')}"></span><span>${escapeHtml(overall.label)}</span></div>
    </div>`;

  for (const { day, items } of perDay) {
    if (!items.length) continue;
    const groups = buildUnits(day.exercises);
    const partnersById = new Map();
    for (const g of groups) if (g.length > 1) for (const e of g) partnersById.set(e.id, g.filter(o => o !== e).map(o => o.name).join(' + '));
    html += `<div class="card flush"><h3 class="card-title">${escapeHtml(day.name)}</h3><div class="coach-list">`;
    for (const { ex, s: sug } of items) {
      const plannedReps = ex.repsScheme[ex.repsScheme.length - 1];
      const partners = partnersById.get(ex.id);
      html += `<div class="coach-row">
        <span class="fatigue-dot ${sug.fatigue.replace(' ', '')}" title="Fatiga ${sug.fatigue}"></span>
        <div class="cr-main">
          <div class="cr-name">${escapeHtml(ex.name)}</div>
          <div class="cr-meta"><span class="mg-chip ${muscleGroupClass(ex.muscleGroup)}">${escapeHtml(ex.muscleGroup)}</span>${ex.sets} × ${repsSchemeLabel(ex)}</div>
          ${partners ? `<div class="ss-tag" style="margin-top:6px">${icon('link')} Superserie con ${escapeHtml(partners)}</div>` : ''}
          ${ex.notes ? `<div class="ex-notes">${icon('paste')}${escapeHtml(ex.notes)}</div>` : ''}
          <div class="cr-note">${escapeHtml(sug.note)}</div>
        </div>
        ${sug.suggestedWeight != null ? `<div class="cr-target"><b>${sug.suggestedWeight > 0 ? fmtNum(sug.suggestedWeight) : 'PC'}</b><small>${sug.suggestedWeight > 0 ? 'kg' : 'peso corp.'} · ${sug.suggestedReps || plannedReps} reps</small></div>` : ''}
      </div>`;
    }
    html += `</div></div>`;
  }
  html += `<p class="hint" style="text-align:center">Sugerencias automáticas según tu historial. No reemplazan a un profesional: ajustalas si algo no te cierra.</p>`;
  main.innerHTML = html;
}

/**
 * El usuario indica en qué semana del bloque está hoy (por ejemplo, porque
 * su entrenador ya le marcó descarga). Se mueve el inicio del ciclo, no la
 * fecha de inicio de la rutina, y se vuelven a marcar las series de hoy
 * con la fase correcta para que el entrenador no las tome como carga.
 */
function setCurrentWeek(weekInBlock) {
  const routine = getActiveRoutine(state);
  if (!routine) return;
  const label = weekInBlock === state.settings.mesocycleWeeks ? 'semana de descarga' : `semana ${weekInBlock} de carga`;
  if (!confirm(`¿Esta semana es tu ${label}? Las próximas semanas se van a calcular a partir de hoy.`)) return;
  const today = todayISO();
  routine.cycleStartDate = cycleStartForWeek(today, weekInBlock);
  const info = weekInfo(routine, today, state.settings);
  for (const l of state.logs) {
    if (l.routineId === routine.id && l.date === today) {
      l.weekNumber = info.weekNumber; l.weekInBlock = info.weekInBlock; l.phase = info.phase;
    }
  }
  todaySets = {}; // las sugerencias de peso cambian con la fase
  persist();
  render();
}

/* ================================================================ Vista: Cuerpo (altura, peso y medidas) ================================================================ */

function parseDecimal(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function latestValue(key) {
  for (let i = state.measurements.length - 1; i >= 0; i--) if (state.measurements[i][key] != null) return state.measurements[i];
  return null;
}
function bmi(weight) {
  const h = state.profile.heightCm;
  return h && weight ? Math.round((weight / ((h / 100) ** 2)) * 10) / 10 : null;
}

function renderCuerpo(main) {
  if (!bodyForm) bodyForm = { date: todayISO(), editingId: null, values: {} };
  const lastW = latestValue('weight');
  const firstW = state.measurements.find(m => m.weight != null);
  const h = state.profile.heightCm;
  const wDiff = lastW && firstW && lastW !== firstW ? Math.round((lastW.weight - firstW.weight) * 10) / 10 : null;

  let html = `<div class="card body-hero" style="margin-top:4px">
    <div class="bh-main">
      <div class="label">Peso actual</div>
      <div class="value">${lastW ? `${fmtNum(lastW.weight)}<small> kg</small>` : '—'}</div>
      <div class="sub">${lastW ? `al ${formatDate(lastW.date).slice(0, 5)}` : 'Sin registros todavía'}${wDiff ? ` · <b>${wDiff > 0 ? '+' : '−'}${fmtNum(Math.abs(wDiff))} kg</b> desde el ${formatDate(firstW.date).slice(0, 5)}` : ''}</div>
    </div>
    <div class="bh-side">
      <button class="bh-stat" onclick="App.editHeight()"><span class="label">Altura</span><b>${h ? `${fmtNum(h)} cm` : 'Cargar'}</b></button>
      <div class="bh-stat"><span class="label">IMC</span><b>${bmi(lastW?.weight) != null ? fmtNum(bmi(lastW.weight)) : '—'}</b></div>
    </div>
  </div>`;

  // formulario
  const v = bodyForm.values;
  html += `<h2 class="section-title">${bodyForm.editingId ? 'Editar medición' : 'Registrar medidas'}</h2>
  <div class="card">
    <label class="field-label">Fecha</label>
    <input class="body-date" type="date" value="${bodyForm.date}" max="${todayISO()}" oninput="App.bodySetDate(this.value)">
    <div class="measure-grid">
      ${MEASURE_FIELDS.map(f => `<label class="measure-field"><span>${f.label}</span>
        <div class="mf-input"><input type="text" inputmode="decimal" autocomplete="off" placeholder="${latestValue(f.key) ? fmtNum(latestValue(f.key)[f.key]) : '—'}" value="${escapeHtml(v[f.key] ?? '')}" oninput="App.bodySetValue('${f.key}', this.value)"><small>${f.unit}</small></div>
      </label>`).join('')}
    </div>
    <p class="hint">Completá solo lo que midas ese día. Lo gris es tu última medición.</p>
    <div class="btn-row">
      ${bodyForm.editingId ? `<button class="btn-secondary" onclick="App.bodyCancelEdit()">Cancelar</button>` : ''}
      <button class="btn-primary" onclick="App.saveMeasurements()">${icon('check')} ${bodyForm.editingId ? 'Guardar cambios' : 'Guardar medidas'}</button>
    </div>
  </div>`;

  if (state.measurements.length) {
    const field = MEASURE_FIELDS.find(f => f.key === bodyMetric);
    const series = state.measurements.filter(m => m[bodyMetric] != null);
    const first = series[0], last = series[series.length - 1];
    const diff = series.length > 1 ? Math.round((last[bodyMetric] - first[bodyMetric]) * 10) / 10 : null;
    html += `<h2 class="section-title">Evolución</h2>
      <div class="segmented scroll">${MEASURE_FIELDS.map(f => `<button class="${f.key === bodyMetric ? 'active' : ''}" onclick="App.setBodyMetric('${f.key}')">${f.label}</button>`).join('')}</div>
      ${series.length ? `<div class="stat-row">
        <div class="stat-tile"><div class="label">Última</div><div class="value">${fmtNum(last[bodyMetric])}<small> ${field.unit}</small></div><div class="sub">${formatDate(last.date).slice(0, 5)}</div></div>
        <div class="stat-tile"><div class="label">Cambio</div><div class="value">${diff == null ? '—' : `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${fmtNum(Math.abs(diff))}<small> ${field.unit}</small>`}</div><div class="sub">${diff == null ? 'Necesita 2 mediciones' : `desde el ${formatDate(first.date).slice(0, 5)}`}</div></div>
      </div>
      <div class="chart-box" id="chartBody"></div>` : `<div class="card"><p class="hint" style="margin:0">Todavía no registraste ${field.label.toLowerCase()}.</p></div>`}
      <h2 class="section-title">Historial</h2>
      <div class="card flush">${state.measurements.slice().reverse().map(m => `<div class="hist-session">
        <div class="hs-head">
          <span class="d">${formatDate(m.date)}</span>
          <span class="row-actions"><button class="icon-btn" onclick="App.editMeasurement('${m.id}')">Editar</button><button class="icon-btn danger" onclick="App.deleteMeasurement('${m.id}')">Borrar</button></span>
        </div>
        <div class="hs-sets">${MEASURE_FIELDS.filter(f => m[f.key] != null).map(f => `${f.label} <b>${fmtNum(m[f.key])} ${f.unit}</b>`).join(' · ')}</div>
      </div>`).join('')}</div>
      <button class="btn-secondary" style="margin-top:4px" onclick="App.exportMeasures()">${icon('download')} Exportar a Excel (.csv)</button>`;
    main.innerHTML = html;
    if (series.length) lineChart(document.getElementById('chartBody'), series.map(m => ({ x: m.date, y: m[bodyMetric], label: formatDate(m.date) })), { seriesColorVar: '--series-1', unit: ` ${field.unit}`, includeZero: false, ariaLabel: `Evolución de ${field.label}` });
    return;
  }
  main.innerHTML = html;
}

function bodySetDate(v) { bodyForm.date = v || todayISO(); }
function bodySetValue(key, v) { bodyForm.values[key] = v; }
function setBodyMetric(k) { bodyMetric = k; render(); }
function bodyCancelEdit() { bodyForm = null; render(); }

function saveMeasurements() {
  const values = {};
  const invalid = [];
  for (const f of MEASURE_FIELDS) {
    const raw = bodyForm.values[f.key];
    if (raw == null || String(raw).trim() === '') { values[f.key] = null; continue; }
    const n = parseDecimal(raw);
    if (n == null) invalid.push(f.label); else values[f.key] = n;
  }
  if (invalid.length) { alert(`Revisá: ${invalid.join(', ')}. Usá solo números (ej: 78,5).`); return; }
  if (bodyForm.editingId) {
    const entry = state.measurements.find(m => m.id === bodyForm.editingId);
    Object.assign(entry, values, { date: bodyForm.date });
    state.measurements.sort((a, b) => a.date.localeCompare(b.date));
  } else {
    if (MEASURE_FIELDS.every(f => values[f.key] == null)) { alert('Cargá al menos una medida.'); return; }
    upsertMeasurement(state, bodyForm.date, values);
  }
  bodyForm = null;
  persist(); render();
}
function editMeasurement(id) {
  const m = state.measurements.find(x => x.id === id);
  const values = {};
  for (const f of MEASURE_FIELDS) values[f.key] = m[f.key] != null ? fmtNum(m[f.key]) : '';
  bodyForm = { date: m.date, editingId: id, values };
  render();
  document.getElementById('main').scrollTo({ top: 0, behavior: 'smooth' });
}
function deleteMeasurement(id) {
  const m = state.measurements.find(x => x.id === id);
  if (!confirm(`¿Borrar la medición del ${formatDate(m.date)}?`)) return;
  state.measurements = state.measurements.filter(x => x.id !== id);
  if (bodyForm?.editingId === id) bodyForm = null;
  persist(); render();
}
function editHeight() {
  const current = state.profile.heightCm ? fmtNum(state.profile.heightCm) : '';
  const value = prompt('Tu altura en centímetros (ej: 178):', current);
  if (value == null) return;
  const n = parseDecimal(value);
  if (n == null || n < 100 || n > 250) { alert('Ingresá la altura en centímetros, entre 100 y 250.'); return; }
  state.profile.heightCm = n;
  persist(); render();
}

/* ================================================================ Vista: Progreso ================================================================ */

function distinctGroupsLogged() {
  const order = getCategories().map(c => c.name);
  return Array.from(new Set(state.logs.map(l => l.muscleGroup))).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
function distinctExercisesLogged() {
  const map = new Map();
  for (const l of state.logs.slice().sort((a, b) => a.ts - b.ts)) map.set(l.exerciseKey, { key: l.exerciseKey, name: l.exerciseName, muscleGroup: l.muscleGroup });
  return Array.from(map.values());
}

/** La mejor serie: más peso; a igual peso, más reps (así un ejercicio con peso corporal compara reps). */
function bestSet(logs) {
  return logs.reduce((best, l) => (!best || l.weight > best.weight || (l.weight === best.weight && l.reps > best.reps)) ? l : best, null);
}
function setLabel(l) { return l.weight > 0 ? `${fmtNum(l.weight)} kg × ${l.reps}` : `${l.reps} reps`; }

/** Sesiones de un ejercicio (una por fecha, más reciente primero), con su mejor serie. */
function exerciseSessions(key) {
  const byDate = new Map();
  for (const l of logsForKey(key)) {
    if (!byDate.has(l.date)) byDate.set(l.date, []);
    byDate.get(l.date).push(l);
  }
  return Array.from(byDate.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, sets]) => {
      sets.sort((a, b) => a.setNumber - b.setNumber || a.ts - b.ts);
      return { date, sets, top: bestSet(sets), deload: sets.some(l => l.phase === 'descarga') };
    });
}

/**
 * Resumen por ejercicio: récord, última sesión y cambio de peso entre la
 * primera y la última sesión de carga (las de descarga son livianas a
 * propósito: compararlas daría una "pérdida" que no es tal).
 */
function exerciseSummary(key) {
  const sessions = exerciseSessions(key);
  const record = bestSet(sessions.map(s => s.top));
  const last = sessions[0];
  const loadSessions = sessions.filter(s => !s.deload);
  const lastLoad = loadSessions[0];
  const first = loadSessions[loadSessions.length - 1];
  const change = loadSessions.length > 1 ? lastLoad.top.weight - first.top.weight : 0;
  return { sessions, record, last, first, change };
}

function changeLabel(summary) {
  if (!summary.change) return '';
  const sign = summary.change > 0 ? '+' : '−';
  return `${sign}${fmtNum(Math.abs(summary.change))} kg desde el ${formatDate(summary.first.date).slice(0, 5)}`;
}

function weightSeriesForExercise(key) {
  return exerciseSessions(key).slice().reverse().map(s => ({ x: s.date, y: s.top.weight, hollow: s.deload, label: `${formatDate(s.date).slice(0, 5)} · ${setLabel(s.top)}${s.deload ? ' · descarga' : ''}` }));
}

function renderProgreso(main) {
  if (!state.logs.length) { main.innerHTML = emptyState('chart', 'Tu progreso', 'Cuando registres series en la pestaña Hoy, acá vas a ver la evolución de cada ejercicio y grupo muscular.'); return; }

  let html = `<div class="segmented" style="margin-top:4px">
    <button class="${progressMode === 'grupo' ? 'active' : ''}" onclick="App.setProgressMode('grupo')">Por grupo muscular</button>
    <button class="${progressMode === 'ejercicio' ? 'active' : ''}" onclick="App.setProgressMode('ejercicio')">Por ejercicio</button>
  </div>`;

  if (progressMode === 'grupo') {
    const groups = distinctGroupsLogged();
    if (!progressGroup || !groups.includes(progressGroup)) progressGroup = groups[0];
    html += `<div class="chip-row">${groups.map(g => `<button class="mg-chip chip-select ${muscleGroupClass(g)} ${g === progressGroup ? 'active' : ''}" onclick="App.setProgressGroup('${g}')">${escapeHtml(g)}</button>`).join('')}</div>`;

    const rows = distinctExercisesLogged()
      .filter(e => e.muscleGroup === progressGroup)
      .map(e => ({ ...e, summary: exerciseSummary(e.key) }))
      .sort((a, b) => b.summary.record.weight - a.summary.record.weight || b.summary.record.reps - a.summary.record.reps);
    const scaleMax = Math.max(...rows.map(r => r.summary.record.weight), 0);

    html += `<h2 class="section-title">Máximo por ejercicio</h2><div class="card flush rec-list">`;
    for (const r of rows) {
      const { record, last } = r.summary;
      const pct = scaleMax && record.weight > 0 ? Math.max(4, (record.weight / scaleMax) * 100) : 0;
      const change = changeLabel(r.summary);
      html += `<button class="rec-row" onclick="App.openExercise('${r.key}')">
        <div class="rec-top"><span class="rec-name">${escapeHtml(r.name)}</span><span class="rec-value">${setLabel(record)}</span></div>
        ${pct ? `<div class="rec-track"><div class="rec-bar" style="width:${pct}%;background:var(${seriesVarFor(r.muscleGroup)})"></div></div>` : ''}
        <div class="rec-meta">Última: ${setLabel(last.top)} · ${formatDate(last.date).slice(0, 5)}${last.deload ? ' (descarga)' : ''}${change ? ` · <b class="${r.summary.change > 0 ? 'up' : 'down'}">${change}</b>` : ''}</div>
      </button>`;
    }
    html += `</div><p class="hint" style="text-align:center">Tocá un ejercicio para ver su evolución.</p>`;
    main.innerHTML = html;
    return;
  }

  const exercises = distinctExercisesLogged();
  if (!progressExKey || !exercises.some(e => e.key === progressExKey)) progressExKey = exercises[0]?.key;
  const current = exercises.find(e => e.key === progressExKey);
  const summary = exerciseSummary(progressExKey);
  const change = changeLabel(summary);

  html += `<select class="ex-picker" onchange="App.setProgressExercise(this.value)">
    ${exercises.map(e => `<option value="${e.key}" ${e.key === progressExKey ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')}
  </select>
  <div class="stat-row">
    <div class="stat-tile"><div class="label">Récord</div><div class="value">${summary.record.weight > 0 ? `${fmtNum(summary.record.weight)}<small> kg</small>` : summary.record.reps}</div><div class="sub">${summary.record.weight > 0 ? `× ${summary.record.reps} reps` : 'reps'} · ${formatDate(summary.record.date).slice(0, 5)}</div></div>
    <div class="stat-tile"><div class="label">Última sesión</div><div class="value">${summary.last.top.weight > 0 ? `${fmtNum(summary.last.top.weight)}<small> kg</small>` : summary.last.top.reps}</div><div class="sub">${summary.last.top.weight > 0 ? `× ${summary.last.top.reps} reps` : 'reps'} · ${formatDate(summary.last.date).slice(0, 5)}</div></div>
  </div>
  ${change ? `<p class="progress-note ${summary.change > 0 ? 'up' : 'down'}">${icon('trend')} ${change}</p>` : ''}
  <h2 class="section-title">Mejor serie por sesión</h2>
  <div class="chart-box" id="chartWeight"></div>
  ${summary.sessions.some(x => x.deload) ? '<p class="hint" style="margin-top:-4px">○ Punto vacío: semana de descarga (liviana a propósito, no cuenta como retroceso).</p>' : ''}
  <h2 class="section-title">Historial</h2>
  <div class="card flush">${summary.sessions.map(sess => `<div class="hist-session">
      <div class="hs-head">
        <span class="d">${formatDate(sess.date)}${sess.deload ? ' <span class="tag">Descarga</span>' : ''}</span>
        <span class="hist-w">${sess.top === summary.record ? icon('trophy') : ''}${setLabel(sess.top)}</span>
      </div>
      <div class="hs-sets">${sess.sets.map(l => `<button class="set-chip" onclick="App.editSetOpen('${l.id}')">${setLabel(l)}</button>`).join('')}</div>
    </div>`).join('')}</div>`;

  main.innerHTML = html;
  lineChart(document.getElementById('chartWeight'), weightSeriesForExercise(progressExKey), { seriesColorVar: seriesVarFor(current?.muscleGroup), unit: ' kg', ariaLabel: `Peso de la mejor serie de ${current?.name} por sesión` });
}

function openExercise(key) { progressMode = 'ejercicio'; progressExKey = key; render(); document.getElementById('main').scrollTop = 0; }
function setProgressMode(m) { progressMode = m; render(); }
function setProgressGroup(g) { progressGroup = g; render(); }
function setProgressExercise(k) { progressExKey = k; render(); }

/* ================================================================ Modal: configuración y respaldo ================================================================ */

function openSettingsModal() { modalView = 'settings'; render(); }
function closeModal() { modalView = null; render(); }

function renderModal() {
  const host = document.getElementById('modalHost');
  const alreadyOpen = !!host.querySelector(`.modal-overlay[data-view="${modalView}"]`);
  if (modalView === 'categories') host.innerHTML = categoriesModalHtml();
  else if (modalView === 'settings') host.innerHTML = settingsModalHtml();
  else if (modalView === 'editSet') host.innerHTML = editSetModalHtml();
  else { host.innerHTML = ''; return; }
  if (!host.innerHTML) return;
  const overlay = host.querySelector('.modal-overlay');
  overlay.dataset.view = modalView;
  if (alreadyOpen) overlay.classList.add('static');
}

function settingsModalHtml() {
  const s = state.settings;
  return `<div class="modal-overlay" onclick="if(event.target===this) App.closeModal()">
    <div class="modal-box">
      <h2>Configuración del entrenador</h2>
      <div class="field"><label>Semanas por bloque (antes de descargar)<span>${s.mesocycleWeeks}</span></label>
        <input type="range" min="2" max="8" value="${s.mesocycleWeeks}" oninput="App.updateSetting('mesocycleWeeks', this.value, this)"></div>
      <div class="field"><label>Reducción en semana de descarga<span>${Math.round((1 - s.deloadFactor) * 100)}%</span></label>
        <input type="range" min="20" max="60" value="${Math.round((1 - s.deloadFactor) * 100)}" oninput="App.updateDeload(this.value, this)"></div>
      <div class="field"><label>Incremento tren superior (kg)</label>
        <input type="number" step="0.5" value="${s.incrementUpper}" oninput="App.updateSetting('incrementUpper', this.value)"></div>
      <div class="field"><label>Incremento tren inferior (kg)</label>
        <input type="number" step="0.5" value="${s.incrementLower}" oninput="App.updateSetting('incrementLower', this.value)"></div>
      <div class="field toggle"><label for="wakeLockToggle">Mantener la pantalla encendida en "Hoy"</label>
        <input type="checkbox" id="wakeLockToggle" ${s.keepScreenOn ? 'checked' : ''} onchange="App.toggleWakeLockSetting(this.checked)"></div>
      ${!('wakeLock' in navigator) ? '<p class="hint" style="margin-top:-8px">Tu navegador no soporta esto acá; no molesta, simplemente no hace nada.</p>' : ''}
      <h2 style="font-size:15px;margin-top:18px">Respaldo de datos</h2>
      <p class="hint">Tus datos se guardan solo en este dispositivo. Descargá una copia de respaldo de vez en cuando.</p>
      <div class="btn-row">
        <button class="btn-secondary" onclick="App.doExport()">Descargar respaldo</button>
        <label class="btn-secondary" style="text-align:center;display:flex;align-items:center;justify-content:center">
          Restaurar<input type="file" accept="application/json" style="display:none" onchange="App.doImport(this)">
        </label>
      </div>
      <h2 style="font-size:15px;margin-top:18px">Exportar para analizar</h2>
      <p class="hint">Archivos .csv que se abren en Excel o Google Sheets.</p>
      <div class="btn-row">
        <button class="btn-secondary" onclick="App.exportWorkouts()">${icon('download')} Entrenamientos</button>
        <button class="btn-secondary" onclick="App.exportMeasures()">${icon('download')} Medidas</button>
      </div>
      <h2 style="font-size:15px;margin-top:18px">Categorías</h2>
      <button class="btn-secondary" onclick="App.openCategories()">Agregar o editar categorías</button>
      <h2 style="font-size:15px;margin-top:18px">Diagnóstico de instalación</h2>
      <p class="hint">Versión ${APP_VERSION}. Si la app no se deja instalar, tocá el botón y mandá una captura de lo que aparece.</p>
      <button class="btn-secondary" onclick="App.runInstallDiagnostics()">Ver diagnóstico</button>
      <pre id="diagOutput" class="diag-output" hidden></pre>
      <div class="modal-close-row"><button class="btn-primary" style="width:auto;padding:9px 20px" onclick="App.closeModal()">Cerrar</button></div>
    </div>
  </div>`;
}

/* ---------------- Categorías (grupos musculares) ---------------- */

function openCategories() { modalView = 'categories'; catDeleting = null; render(); }

function categoriesModalHtml() {
  const cats = getCategories();
  const rows = cats.map((c, i) => {
    const usage = categoryUsage(state, c.name);
    const used = usage.exercises || usage.sets;
    const others = cats.filter((_, j) => j !== i);
    const del = catDeleting === i ? `<div class="cat-delete">
        ${used ? `<label class="field-label">Mover sus ${usage.exercises} ejercicios y ${usage.sets} series a</label>
          <select id="catMoveTo">${others.map(o => `<option value="${escapeHtml(o.name)}">${escapeHtml(o.name)}</option>`).join('')}</select>` : '<p class="hint" style="margin:0 0 8px">No la usa ningún ejercicio.</p>'}
        <div class="btn-row"><button class="btn-secondary" onclick="App.cancelDeleteCat()">Cancelar</button><button class="btn-primary danger" onclick="App.confirmDeleteCat(${i})">Borrar</button></div>
      </div>` : '';
    return `<div class="cat-row">
        <span class="cat-dot" style="background:var(--series-${c.slot})"></span>
        <input class="cat-name" value="${escapeHtml(c.name)}" aria-label="Nombre de la categoría" onchange="App.renameCat(${i}, this.value)">
        <span class="cat-usage">${usage.exercises} ej.</span>
        ${cats.length > 1 ? `<button class="icon-btn" onclick="App.askDeleteCat(${i})">Borrar</button>` : ''}
      </div>${del}`;
  }).join('');
  const full = cats.length >= MAX_CATEGORIES;
  return `<div class="modal-overlay" onclick="if(event.target===this) App.closeModal()">
    <div class="modal-box">
      <h2>Categorías</h2>
      <p class="hint">Tocá un nombre para cambiarlo: se actualiza en tus rutinas y en todo tu historial.</p>
      <div class="cat-list">${rows}</div>
      ${full ? `<p class="hint">Llegaste al máximo de ${MAX_CATEGORIES} categorías (una por color).</p>` : `<div class="cat-add">
        <input id="newCatName" placeholder="Nueva categoría (ej: Glúteos)" aria-label="Nueva categoría" onkeydown="if(event.key==='Enter') App.addCat()">
        <button class="btn-primary" onclick="App.addCat()">${icon('plus')} Agregar</button>
      </div>`}
      <div class="modal-close-row"><button class="btn-secondary" style="width:auto;padding:9px 20px" onclick="App.closeModal()">Listo</button></div>
    </div>
  </div>`;
}

function renameCat(i, value) {
  const cat = getCategories()[i];
  const name = value.trim();
  if (!name || name === cat.name) { render(); return; }
  if (categoryNameTaken(state, name, cat.name)) { alert(`Ya existe la categoría "${name}".`); render(); return; }
  renameCategory(state, cat.name, name);
  if (progressGroup === cat.name) progressGroup = name;
  persist(); render();
}
function addCat() {
  const input = document.getElementById('newCatName');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  if (categoryNameTaken(state, name)) { alert(`Ya existe la categoría "${name}".`); return; }
  state.categories.push({ name, slot: freeSlot() });
  setCategories(state.categories);
  persist(); render();
}
function askDeleteCat(i) { catDeleting = i; render(); }
function cancelDeleteCat() { catDeleting = null; render(); }
function confirmDeleteCat(i) {
  const cat = getCategories()[i];
  const others = getCategories().filter((_, j) => j !== i);
  const moveTo = document.getElementById('catMoveTo')?.value || others[0].name;
  deleteCategory(state, cat.name, moveTo);
  catDeleting = null;
  persist(); render();
}

function updateSetting(key, value) { state.settings[key] = parseFloat(value) || DEFAULT_SETTINGS[key]; persist(); render(); }
function updateDeload(pct, el) { state.settings.deloadFactor = 1 - (parseFloat(pct) / 100); persist(); render(); }
function doExport() { exportBackup(state); state.lastBackupAt = todayISO(); state.backupSnoozeUntil = null; persist(); render(); }
function snoozeBackup() {
  const d = new Date(); d.setDate(d.getDate() + 7);
  state.backupSnoozeUntil = d.toISOString().slice(0, 10);
  persist(); render();
}
function toggleWakeLockSetting(checked) { state.settings.keepScreenOn = checked; persist(); syncWakeLock(); }
function doImport(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = importBackup(reader.result);
      todaySets = {};
      persist(); closeModal(); render();
    } catch (e) { alert('No pude leer ese archivo de respaldo.'); }
  };
  reader.readAsText(file);
}

/* ================================================================ Diagnóstico de instalación (PWA) ================================================================ */

/**
 * Revisa desde el propio dispositivo los requisitos para instalar la app
 * (manifest, íconos, service worker, HTTPS). Existe porque el navegador
 * del celular no explica por qué rechaza la instalación.
 */
async function runInstallDiagnostics() {
  const out = document.getElementById('diagOutput');
  out.hidden = false;
  out.textContent = 'Revisando…';
  const lines = [`Versión: ${APP_VERSION}`, `URL: ${location.href}`, `Contexto seguro (HTTPS): ${window.isSecureContext ? 'sí' : 'NO'}`];

  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (!manifestLink) {
    lines.push('Manifest: NO está enlazado en la página');
  } else {
    try {
      const res = await fetch(manifestLink.href, { cache: 'no-store' });
      lines.push(`Manifest: ${res.status} (${res.headers.get('content-type') || 'sin tipo'})`);
      const manifest = await res.json();
      lines.push(`  nombre: ${manifest.name} · display: ${manifest.display} · start_url: ${manifest.start_url}`);
      for (const icon of manifest.icons || []) {
        const iconUrl = new URL(icon.src, manifestLink.href).href;
        const iconRes = await fetch(iconUrl, { cache: 'no-store' }).catch(() => null);
        lines.push(`  ícono ${icon.sizes} (${icon.purpose}): ${iconRes ? iconRes.status : 'error de red'}`);
      }
    } catch (e) {
      lines.push(`Manifest: ERROR al leerlo — ${e.message}`);
    }
  }

  if (!('serviceWorker' in navigator)) {
    lines.push('Service worker: el navegador no lo soporta');
  } else {
    const reg = await navigator.serviceWorker.getRegistration();
    lines.push(`Service worker: ${reg ? `registrado (activo: ${reg.active ? 'sí' : 'no'}, scope: ${reg.scope})` : 'NO registrado'}`);
    if (swRegistrationError) lines.push(`  error al registrar: ${swRegistrationError}`);
  }

  if (navigator.storage?.persisted) {
    lines.push(`Almacenamiento persistente: ${await navigator.storage.persisted() ? 'sí' : 'no'}`);
  } else {
    lines.push('Almacenamiento persistente: no soportado por este navegador');
  }
  lines.push(`Pantalla encendida (Wake Lock): ${'wakeLock' in navigator ? 'soportado' : 'no soportado en este navegador'}`);
  lines.push(`Ya instalada (modo app): ${window.matchMedia('(display-mode: standalone)').matches ? 'sí' : 'no'}`);
  lines.push(`El navegador ofreció instalar: ${installPromptFired ? 'sí' : 'no'}`);
  lines.push(`Navegador: ${navigator.userAgent}`);
  out.textContent = lines.join('\n');
}

/* ================================================================ Init ================================================================ */

window.App = {
  switchTab, selectDay, focusExercise, adjustWeight, adjustReps, useSuggestion, setWeight, setReps, logSet,
  skipRest: () => skipRest(renderRestBar), addRest: (s) => addRestTime(s, renderRestBar),
  startNewRoutine, cancelWizard, activateRoutine, deleteRoutine, editRoutine, chooseMethod,
  handleDocxFile, handlePasteText, wizardSetName, wizardSetDate, wizardAddDay, wizardRemoveDay,
  wizardRenameDay, wizardAddExercise, wizardRemoveEx, wizardUpdateEx, wizardToggleSuperset, saveWizard,
  setProgressMode, setProgressGroup, setProgressExercise, openExercise,
  openSettingsModal, closeModal, updateSetting, updateDeload, doExport, doImport,
  runInstallDiagnostics, setCurrentWeek,
  openCategories, renameCat, addCat, askDeleteCat, cancelDeleteCat, confirmDeleteCat,
  bodySetDate, bodySetValue, setBodyMetric, bodyCancelEdit, saveMeasurements, editMeasurement, deleteMeasurement, editHeight,
  exportWorkouts: () => exportWorkoutsCsv(state), exportMeasures: () => exportMeasurementsCsv(state),
  editSetOpen, saveEditedSet, deleteEditedSet, snoozeBackup, toggleWakeLockSetting,
};

document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
document.querySelectorAll('nav.tabbar button').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.view)));
document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);

// PWA: se instala en el dispositivo y funciona sin conexión (el "backend" es el propio localStorage).
let swRegistrationError = null;
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((err) => {
    swRegistrationError = err.message; // sin sw la app sigue funcionando, solo no queda offline
  }));
}
let deferredInstallPrompt = null;
let installPromptFired = false;
const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installPromptFired = true;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  installBtn.hidden = true;
  await deferredInstallPrompt.prompt();
  deferredInstallPrompt = null;
});
window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

// Le pedimos al navegador que no borre estos datos solo (por poco espacio, por "limpiar todo", etc.).
// No siempre lo concede, y no hay nada que hacer si lo niega: por eso además existe el respaldo manual.
navigator.storage?.persist?.().catch(() => {});

// Al volver de segundo plano (se bloqueó el celular, se cambió de app): el timer de descanso puede haber
// seguido corriendo sin que un setInterval común lo notara, y el wake lock se libera solo al ocultar la pestaña.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    resyncRest(renderRestBar);
    syncWakeLock();
  }
});

if (!state.selectedDayId) { const r = getActiveRoutine(state); state.selectedDayId = r?.days[0]?.id || null; }
render();
