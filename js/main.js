import {
  loadState, saveState, uid, todayISO, normalizeName,
  getRoutine, getActiveRoutine, exportBackup, importBackup, DEFAULT_SETTINGS,
} from './state.js';
import { MUSCLE_GROUPS, muscleGroupClass, guessMuscleGroup, slotFor } from './muscleGroups.js';
import { extractTextFromDocx, parseRoutineText, PASTE_PLACEHOLDER } from './parser.js';
import { weekInfo, nextDeloadDate, suggestForExercise, overallFatigue } from './coach.js';
import { restTimer, startRest, skipRest } from './timer.js';
import { lineChart, barChart } from './charts.js';

let state = loadState();
let currentView = 'hoy';
/** progreso de series de hoy por ejercicio: { [exerciseId]: { setsLogged, weight, reps } } */
let todaySets = {};
let progressMode = 'grupo';
let progressGroup = null;
let progressExKey = null;
let routineWizard = null; // asistente de creación/edición de rutina
let modalView = null;     // 'settings' | null

const WEEKDAY_LABELS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function persist() { saveState(state); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function formatToday() { const d = new Date(); return `${WEEKDAY_LABELS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; }
function seriesVarFor(muscleGroup) { const slot = slotFor(muscleGroup) || 1; return `--series-${slot}`; }

/* ================================================================
   Datos derivados (cruzan rutinas: se agrupan por exerciseKey, no
   por el id del ejercicio dentro de una rutina puntual)
   ================================================================ */

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
  else renderProgreso(main);
  renderModal();
}

function switchTab(view) { currentView = view; render(); }

/* ================================================================ Vista: Hoy ================================================================ */

function getSelectedDay() {
  const routine = getActiveRoutine(state);
  if (!routine) return null;
  return routine.days.find(d => d.id === state.selectedDayId) || routine.days[0] || null;
}

function renderHoy(main) {
  const routine = getActiveRoutine(state);
  if (!routine) {
    main.innerHTML = `<div class="empty">Todavía no cargaste ninguna rutina.<br><br>
      <button class="btn-primary" style="width:auto;padding:10px 18px" onclick="App.switchTab('rutinas')">Cargar mi rutina</button></div>`;
    return;
  }
  const day = getSelectedDay();
  const info = weekInfo(routine, todayISO(), state.settings);

  let html = '';
  if (restTimer.active) {
    const m = String(Math.floor(restTimer.secondsLeft / 60)).padStart(2, '0');
    const s = String(restTimer.secondsLeft % 60).padStart(2, '0');
    html += `<div class="rest-bar"><span>Descanso · ${escapeHtml(restTimer.exerciseName)} · ${m}:${s}</span>
      <button onclick="App.skipRest()">Saltar</button></div>`;
  }

  html += `<select class="day-select" onchange="App.selectDay(this.value)">
    ${routine.days.map(d => `<option value="${d.id}" ${d.id === day.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
  </select>`;

  if (!day.exercises.length) {
    html += `<div class="empty">Este día todavía no tiene ejercicios cargados.</div>`;
  }

  for (const ex of day.exercises) {
    const key = normalizeName(ex.name);
    const suggestion = suggestForExercise({ exerciseName: ex.name, muscleGroup: ex.muscleGroup, plannedReps: ex.reps }, state.logs, state.settings, info.phase);

    if (!todaySets[ex.id]) {
      const defaultWeight = suggestion.suggestedWeight != null ? suggestion.suggestedWeight : (lastWeightFor(key) ?? 0);
      todaySets[ex.id] = { setsLogged: 0, weight: defaultWeight, reps: suggestion.suggestedReps || ex.reps };
    }
    const prog = todaySets[ex.id];
    const done = prog.setsLogged >= ex.sets;
    const last = lastWeightFor(key);
    const dots = Array.from({ length: ex.sets }, (_, i) => `<span class="dot ${i < prog.setsLogged ? 'filled' : ''}"></span>`).join('');

    html += `<div class="card ${done ? 'done' : ''}">
      <div class="chip-row" style="margin-bottom:6px">
        <span class="mg-chip ${muscleGroupClass(ex.muscleGroup)}">${escapeHtml(ex.muscleGroup)}</span>
      </div>
      <p class="ex-name">${escapeHtml(ex.name)}</p>
      <p class="ex-meta">${ex.sets} series × ${ex.reps} reps · descanso ${ex.restSeconds}s
        ${last != null ? ` · última vez: <b>${last} kg</b>` : ''}</p>
      ${suggestion.suggestedWeight != null ? `<p class="coach-hint">Sugerido hoy: <b>${suggestion.suggestedWeight} kg × ${suggestion.suggestedReps || ex.reps}</b><br>${escapeHtml(suggestion.note)}</p>` : `<p class="coach-hint">${escapeHtml(suggestion.note)}</p>`}
      <div class="weight-row">
        <button class="stepper-btn" onclick="App.adjustWeight('${ex.id}', -2.5)">−</button>
        <input class="weight-value" type="number" step="0.5" value="${prog.weight}" oninput="App.setWeight('${ex.id}', this.value)">
        <button class="stepper-btn" onclick="App.adjustWeight('${ex.id}', 2.5)">+</button>
      </div>
      <p class="weight-unit">kg</p>
      <div class="reps-row"><span>Reps:</span><input type="number" value="${prog.reps}" oninput="App.setReps('${ex.id}', this.value)"></div>
      <div class="set-dots">${dots}</div>
      <button class="btn-primary" ${done ? 'disabled' : ''} onclick="App.logSet('${ex.id}', '${day.id}')">
        ${done ? 'Ejercicio completo' : `Registrar serie ${prog.setsLogged + 1} / ${ex.sets}`}
      </button>
      <div id="pr-${ex.id}"></div>
    </div>`;
  }
  main.innerHTML = html;
}

function selectDay(id) { state.selectedDayId = id; todaySets = {}; persist(); render(); }
function adjustWeight(exId, delta) { todaySets[exId].weight = Math.max(0, Math.round((todaySets[exId].weight + delta) * 2) / 2); render(); }
function setWeight(exId, value) { todaySets[exId].weight = parseFloat(value) || 0; }
function setReps(exId, value) { todaySets[exId].reps = parseInt(value, 10) || 0; }

function logSet(exId, dayId) {
  const routine = getActiveRoutine(state);
  const day = routine.days.find(d => d.id === dayId);
  const ex = day.exercises.find(e => e.id === exId);
  const key = normalizeName(ex.name);
  const prog = todaySets[exId];
  const wasMax = maxWeightFor(key);
  const info = weekInfo(routine, todayISO(), state.settings);

  state.logs.push({
    id: uid(), ts: Date.now(), date: todayISO(), routineId: routine.id, dayId,
    exerciseId: exId, exerciseName: ex.name, exerciseKey: key, muscleGroup: ex.muscleGroup,
    weight: prog.weight, reps: prog.reps, setNumber: prog.setsLogged + 1,
    weekNumber: info.weekNumber, weekInBlock: info.weekInBlock, phase: info.phase,
  });
  prog.setsLogged++;
  persist();

  if (prog.weight > wasMax) {
    const el = document.getElementById(`pr-${exId}`);
    if (el) el.innerHTML = `<p class="pr-badge">Nuevo PR: ${prog.weight} kg</p>`;
  }
  if (prog.setsLogged < ex.sets) startRest(ex.restSeconds, ex.name, render);
  render();
}

/* ================================================================ Vista: Rutinas ================================================================ */

function summaryChipsForRoutine(routine) {
  const groups = new Set();
  for (const d of routine.days) for (const e of d.exercises) groups.add(e.muscleGroup);
  return Array.from(groups).map(g => `<span class="mg-chip ${muscleGroupClass(g)}">${escapeHtml(g)}</span>`).join('');
}

function renderRutinas(main) {
  if (routineWizard) { renderWizard(main); return; }

  let html = `<h2 class="section-title">Tus rutinas</h2>
    <p class="hint">Cargá una rutina distinta cada vez que tu entrenador te la cambie (cada ~3 meses): el historial y tu progreso se guardan igual, aunque cambies de rutina.</p>`;

  if (!state.routines.length) {
    html += `<div class="empty">Todavía no cargaste ninguna rutina.</div>`;
  }

  for (const r of state.routines) {
    const active = r.id === state.activeRoutineId;
    const exCount = r.days.reduce((a, d) => a + d.exercises.length, 0);
    html += `<div class="card routine-card">
      ${active ? '<span class="badge-active">Activa</span>' : ''}
      <h3>${escapeHtml(r.name)}</h3>
      <p class="sub">Desde ${r.startDate} · ${r.days.length} días · ${exCount} ejercicios</p>
      <div class="chip-row">${summaryChipsForRoutine(r)}</div>
      <div class="btn-row">
        ${active ? '' : `<button class="btn-secondary" onclick="App.activateRoutine('${r.id}')">Activar</button>`}
        <button class="btn-secondary" onclick="App.editRoutine('${r.id}')">Editar</button>
      </div>
      <div style="text-align:right;margin-top:6px"><button class="btn-danger" onclick="App.deleteRoutine('${r.id}')">Eliminar rutina</button></div>
    </div>`;
  }

  html += `<button class="add-day-btn" onclick="App.startNewRoutine()">+ Nueva rutina</button>`;
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
    main.innerHTML = `<h2 class="section-title">¿Cómo querés cargar la rutina?</h2>
      <button class="btn-secondary" style="margin-bottom:8px" onclick="App.chooseMethod('upload')">📄 Subir archivo Word (.docx)</button>
      <button class="btn-secondary" style="margin-bottom:8px" onclick="App.chooseMethod('paste')">✏️ Pegar el texto de la rutina</button>
      <button class="btn-secondary" style="margin-bottom:8px" onclick="App.chooseMethod('manual')">➕ Crearla a mano</button>
      <button class="btn-danger" onclick="App.cancelWizard()">Cancelar</button>`;
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
      <p class="hint">Un ejercicio por línea, con el formato "Ejercicio 4x10 descanso 90s". Los encabezados de día ("Día 1", "Lunes", ...) separan los días.</p>
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
    for (const ex of day.exercises) {
      html += `<div class="ex-row">
        <input placeholder="Ejercicio" value="${escapeHtml(ex.name)}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','name',this.value)">
        <select onchange="App.wizardUpdateEx('${day.id}','${ex.id}','muscleGroup',this.value)">
          ${MUSCLE_GROUPS.map(g => `<option value="${g.key}" ${g.key === ex.muscleGroup ? 'selected' : ''}>${g.key}</option>`).join('')}
        </select>
        <input type="number" title="series" value="${ex.sets}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','sets',this.value)">
        <input type="number" title="reps" value="${ex.reps}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','reps',this.value)">
        <input type="number" title="descanso (s)" value="${ex.restSeconds}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','restSeconds',this.value)">
        <button class="icon-btn" onclick="App.wizardRemoveEx('${day.id}','${ex.id}')">✕</button>
      </div>`;
    }
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
  routineWizard.days.find(d => d.id === dayId).exercises.push({ id: uid(), name: '', muscleGroup: 'Otro', sets: 4, reps: 10, restSeconds: 90 });
  render();
}
function wizardRemoveEx(dayId, exId) {
  const day = routineWizard.days.find(d => d.id === dayId);
  day.exercises = day.exercises.filter(e => e.id !== exId);
  render();
}
function wizardUpdateEx(dayId, exId, field, value) {
  const ex = routineWizard.days.find(d => d.id === dayId).exercises.find(e => e.id === exId);
  if (field === 'name') { ex.name = value; if (ex.muscleGroup === 'Otro') ex.muscleGroup = guessMuscleGroup(value); }
  else if (field === 'muscleGroup') ex.muscleGroup = value;
  else ex[field] = parseFloat(value) || 0;
}

function saveWizard() {
  const w = routineWizard;
  if (!w.name.trim()) { alert('Ponele un nombre a la rutina.'); return; }
  const cleanDays = w.days.map(d => ({ ...d, exercises: d.exercises.filter(e => e.name.trim()) }));

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
  if (!routine) { main.innerHTML = `<div class="empty">Cargá una rutina para que pueda armarte un plan de progresión.</div>`; return; }

  const info = weekInfo(routine, todayISO(), state.settings);
  const deload = nextDeloadDate(routine, state.settings, todayISO());

  const flatExercises = [];
  for (const day of routine.days) for (const ex of day.exercises) flatExercises.push({ day, ex });
  const suggestions = flatExercises.map(({ ex }) => suggestForExercise({ exerciseName: ex.name, muscleGroup: ex.muscleGroup, plannedReps: ex.reps }, state.logs, state.settings, info.phase));
  const overall = overallFatigue(suggestions);

  let html = `<h2 class="section-title">Tu entrenador</h2>
    <div class="card">
      <span class="phase-pill ${info.phase}">Semana ${info.weekInBlock} de ${state.settings.mesocycleWeeks} · ${info.phase === 'descarga' ? 'Descarga' : 'Carga'}</span>
      <p class="hint" style="margin-top:8px">Bloque #${info.blockNumber} · semana ${info.weekNumber} desde que empezaste esta rutina.
        ${info.phase === 'carga' ? `Próxima descarga: <b>${deload}</b>.` : 'Esta semana bajá intensidad y priorizá la recuperación.'}</p>
      <div class="fatigue-meter"><span class="fatigue-dot ${overall.level.replace(' ', '')}"></span><span>${escapeHtml(overall.label)}</span></div>
      <p class="hint">Sugerencias automáticas según tu historial de series. No reemplazan a un profesional — ajustalas si algo no te cierra.</p>
    </div>`;

  for (const day of routine.days) {
    if (!day.exercises.length) continue;
    html += `<h2 class="section-title">${escapeHtml(day.name)}</h2>`;
    for (const ex of day.exercises) {
      const s = suggestForExercise({ exerciseName: ex.name, muscleGroup: ex.muscleGroup, plannedReps: ex.reps }, state.logs, state.settings, info.phase);
      const fatigueClass = s.fatigue.replace(' ', '');
      html += `<div class="card suggestion-card">
        <div class="suggestion-head">
          <span class="mg-chip ${muscleGroupClass(ex.muscleGroup)}">${escapeHtml(ex.muscleGroup)}</span>
          <span class="fatigue-tag ${fatigueClass}">Fatiga ${s.fatigue}</span>
        </div>
        <p class="ex-name" style="margin-top:6px">${escapeHtml(ex.name)}</p>
        ${s.suggestedWeight != null ? `<p class="suggested-weight">${s.suggestedWeight} kg × ${s.suggestedReps || ex.reps}</p>` : ''}
        <p class="hint" style="margin-bottom:0">${escapeHtml(s.note)}</p>
      </div>`;
    }
  }
  main.innerHTML = html;
}

/* ================================================================ Vista: Progreso ================================================================ */

function distinctGroupsLogged() { return Array.from(new Set(state.logs.map(l => l.muscleGroup))); }
function distinctExercisesLogged() {
  const map = new Map();
  for (const l of state.logs.slice().sort((a, b) => a.ts - b.ts)) map.set(l.exerciseKey, { key: l.exerciseKey, name: l.exerciseName, muscleGroup: l.muscleGroup });
  return Array.from(map.values());
}

function volumeSeriesForGroup(group) {
  const byDate = new Map();
  for (const l of state.logs) {
    if (l.muscleGroup !== group) continue;
    byDate.set(l.date, (byDate.get(l.date) || 0) + l.weight * l.reps);
  }
  return Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([x, y]) => ({ x, y: Math.round(y) }));
}

function volumeByExerciseInGroup(group) {
  const byKey = new Map();
  for (const l of state.logs) {
    if (l.muscleGroup !== group) continue;
    const cur = byKey.get(l.exerciseKey) || { label: l.exerciseName, value: 0 };
    cur.value += l.weight * l.reps;
    byKey.set(l.exerciseKey, cur);
  }
  return Array.from(byKey.values()).map(v => ({ ...v, value: Math.round(v.value) })).sort((a, b) => b.value - a.value).slice(0, 8);
}

function weightSeriesForExercise(key) {
  const byDate = new Map();
  for (const l of state.logs) {
    if (l.exerciseKey !== key) continue;
    byDate.set(l.date, Math.max(byDate.get(l.date) || 0, l.weight));
  }
  return Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([x, y]) => ({ x, y }));
}

function renderProgreso(main) {
  if (!state.logs.length) { main.innerHTML = `<div class="empty">Cuando registres series en la pestaña <b>Hoy</b>, vas a ver acá tu progreso histórico.</div>`; return; }

  let html = `<div class="import-tabs">
    <button class="${progressMode === 'grupo' ? 'active' : ''}" onclick="App.setProgressMode('grupo')">Por grupo muscular</button>
    <button class="${progressMode === 'ejercicio' ? 'active' : ''}" onclick="App.setProgressMode('ejercicio')">Por ejercicio</button>
  </div>`;

  if (progressMode === 'grupo') {
    const groups = distinctGroupsLogged();
    if (!progressGroup || !groups.includes(progressGroup)) progressGroup = groups[0];
    html += `<div class="chip-row">${groups.map(g => `<button class="mg-chip chip-select ${muscleGroupClass(g)} ${g === progressGroup ? 'active' : ''}" onclick="App.setProgressGroup('${g}')">${escapeHtml(g)}</button>`).join('')}</div>`;
    html += `<h2 class="section-title">Volumen total (kg × reps) por sesión</h2><div class="chart-box" id="chartVolume"></div>`;
    html += `<h2 class="section-title">Volumen por ejercicio</h2><div class="chart-box" id="chartByEx"></div>`;
    main.innerHTML = html;
    lineChart(document.getElementById('chartVolume'), volumeSeriesForGroup(progressGroup), { seriesColorVar: seriesVarFor(progressGroup), unit: '', ariaLabel: `Volumen de ${progressGroup} por sesión` });
    barChart(document.getElementById('chartByEx'), volumeByExerciseInGroup(progressGroup).map(b => ({ ...b, colorVar: seriesVarFor(progressGroup) })), { ariaLabel: `Volumen por ejercicio en ${progressGroup}` });
    return;
  }

  const exercises = distinctExercisesLogged();
  if (!progressExKey || !exercises.some(e => e.key === progressExKey)) progressExKey = exercises[0]?.key;
  const current = exercises.find(e => e.key === progressExKey);

  html += `<select class="ex-picker" onchange="App.setProgressExercise(this.value)">
    ${exercises.map(e => `<option value="${e.key}" ${e.key === progressExKey ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')}
  </select>`;

  const max = maxWeightFor(progressExKey);
  const entries = logsForKey(progressExKey).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  const sessions = new Set(entries.map(e => e.date)).size;

  html += `<div class="stat-row">
    <div class="stat-tile"><div class="label">Récord</div><div class="value">${max} kg</div></div>
    <div class="stat-tile"><div class="label">Sesiones</div><div class="value">${sessions}</div></div>
  </div>
  <div class="chart-box" id="chartWeight"></div>
  <h2 class="section-title">Historial</h2>
  <div class="card">${entries.map(e => `<div class="hist-item"><span class="d">${e.date}</span><span class="hist-w">${e.weight} kg × ${e.reps}${e.weight === max ? ' 🏆' : ''}</span></div>`).join('') || '<p class="hint">Sin registros todavía.</p>'}</div>`;

  main.innerHTML = html;
  lineChart(document.getElementById('chartWeight'), weightSeriesForExercise(progressExKey), { seriesColorVar: seriesVarFor(current?.muscleGroup), unit: ' kg', ariaLabel: `Peso máximo de ${current?.name} por sesión` });
}

function setProgressMode(m) { progressMode = m; render(); }
function setProgressGroup(g) { progressGroup = g; render(); }
function setProgressExercise(k) { progressExKey = k; render(); }

/* ================================================================ Modal: configuración y respaldo ================================================================ */

function openSettingsModal() { modalView = 'settings'; render(); }
function closeModal() { modalView = null; render(); }

function renderModal() {
  const host = document.getElementById('modalHost');
  if (modalView !== 'settings') { host.innerHTML = ''; return; }
  const s = state.settings;
  host.innerHTML = `<div class="modal-overlay" onclick="if(event.target===this) App.closeModal()">
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
      <h2 style="font-size:15px;margin-top:18px">Respaldo de datos</h2>
      <p class="hint">Tus datos se guardan solo en este dispositivo. Descargá una copia de respaldo de vez en cuando.</p>
      <div class="btn-row">
        <button class="btn-secondary" onclick="App.doExport()">Descargar respaldo</button>
        <label class="btn-secondary" style="text-align:center;display:flex;align-items:center;justify-content:center">
          Restaurar<input type="file" accept="application/json" style="display:none" onchange="App.doImport(this)">
        </label>
      </div>
      <div class="modal-close-row"><button class="btn-primary" style="width:auto;padding:9px 20px" onclick="App.closeModal()">Cerrar</button></div>
    </div>
  </div>`;
}

function updateSetting(key, value) { state.settings[key] = parseFloat(value) || DEFAULT_SETTINGS[key]; persist(); render(); }
function updateDeload(pct, el) { state.settings.deloadFactor = 1 - (parseFloat(pct) / 100); persist(); render(); }
function doExport() { exportBackup(state); }
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

/* ================================================================ Init ================================================================ */

window.App = {
  switchTab, selectDay, adjustWeight, setWeight, setReps, logSet, skipRest: () => skipRest(render),
  startNewRoutine, cancelWizard, activateRoutine, deleteRoutine, editRoutine, chooseMethod,
  handleDocxFile, handlePasteText, wizardSetName, wizardSetDate, wizardAddDay, wizardRemoveDay,
  wizardRenameDay, wizardAddExercise, wizardRemoveEx, wizardUpdateEx, saveWizard,
  setProgressMode, setProgressGroup, setProgressExercise,
  openSettingsModal, closeModal, updateSetting, updateDeload, doExport, doImport,
};

document.querySelectorAll('nav.tabbar button').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.view)));
document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);

if (!state.selectedDayId) { const r = getActiveRoutine(state); state.selectedDayId = r?.days[0]?.id || null; }
render();
