import {
  loadState, saveState, uid, todayISO, normalizeName,
  getRoutine, getActiveRoutine, exportBackup, importBackup, DEFAULT_SETTINGS,
  repsForSetIndex, repsSchemeLabel, parseRepsSchemeInput,
} from './state.js';
import { MUSCLE_GROUPS, muscleGroupClass, guessMuscleGroup, slotFor } from './muscleGroups.js';
import { extractTextFromDocx, parseRoutineText, PASTE_PLACEHOLDER } from './parser.js';
import { weekInfo, nextDeloadDate, suggestForExercise, overallFatigue } from './coach.js';
import { restTimer, startRest, skipRest, addRestTime } from './timer.js';
import { icon } from './icons.js';
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
let focusedExId = null;   // ejercicio que el usuario eligió hacer ahora (si no, el primero sin completar)

/** Se muestra en el diagnóstico para confirmar que el dispositivo tiene la última versión publicada. */
const APP_VERSION = '2026-09-25.2';

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
  else renderProgreso(main);
  renderModal();
  renderRestBar();
}

function switchTab(view) { currentView = view; render(); }

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
  const focused = rows.find(r => r.ex.id === focusedExId && !r.done);
  const current = focused || rows.find(r => !r.done) || null;

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

  rows.forEach((r, i) => { html += exerciseCardHtml(r, i, r === current, day.id); });
  main.innerHTML = html;
}

function exerciseCardHtml(r, index, isCurrent, dayId) {
  const { ex, key, suggestion, logged, prog, done } = r;
  const last = lastWeightFor(key);
  const state_ = done ? 'done' : isCurrent ? 'current' : '';

  const pills = Array.from({ length: ex.sets }, (_, s) => {
    const l = logged[s];
    if (l) return `<div class="set-pill done"><span class="set-n">S${s + 1}</span><b>${l.weight > 0 ? fmtNum(l.weight) : '—'}</b><small>${l.weight > 0 ? 'kg ' : ''}× ${l.reps}</small></div>`;
    const cls = isCurrent && s === prog.setsLogged ? 'current' : '';
    return `<div class="set-pill ${cls}"><span class="set-n">S${s + 1}</span><b>${repsForSetIndex(ex, s)}</b><small>reps</small></div>`;
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
    return `<article class="ex-card ${state_}"${tap}>${head}<div class="set-track">${pills}</div>${prBadge}</article>`;
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

function selectDay(id) { state.selectedDayId = id; todaySets = {}; focusedExId = null; persist(); render(); }
function focusExercise(id) { focusedExId = id; render(); document.getElementById(`ex-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
function adjustWeight(exId, delta) { todaySets[exId].weight = Math.max(0, Math.round((todaySets[exId].weight + delta) * 2) / 2); render(); }
function adjustReps(exId, delta) { todaySets[exId].reps = Math.max(0, todaySets[exId].reps + delta); render(); }
function useSuggestion(exId, weight) { todaySets[exId].weight = weight; render(); }
/** Acepta coma o punto decimal ("42,5" o "42.5"); no redibuja para no interrumpir lo que se está escribiendo. */
function setWeight(exId, value) { todaySets[exId].weight = Math.max(0, parseFloat(String(value).replace(',', '.')) || 0); }
function setReps(exId, value) { todaySets[exId].reps = Math.max(0, parseInt(value, 10) || 0); }

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
  if (prog.weight > 0 && prog.weight > wasMax) prog.pr = prog.weight;
  persist();

  const finished = prog.setsLogged >= ex.sets;
  if (!finished) {
    prog.reps = repsForSetIndex(ex, prog.setsLogged); // la próxima serie muestra su propia meta de reps (esquema piramidal)
    startRest(ex.restSeconds, ex.name, renderRestBar);
  } else {
    focusedExId = null;
    skipRest(renderRestBar);
  }
  render();
  if (finished) document.querySelector('.ex-card.current')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    <p class="hint" style="text-align:center;margin-top:12px">El historial se guarda por ejercicio: aunque cambies de rutina cada 3 meses, tu progreso sigue.</p>`;
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
    for (const ex of day.exercises) {
      html += `<div class="ex-row">
        <input placeholder="Ejercicio" value="${escapeHtml(ex.name)}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','name',this.value)">
        <select onchange="App.wizardUpdateEx('${day.id}','${ex.id}','muscleGroup',this.value)">
          ${MUSCLE_GROUPS.map(g => `<option value="${g.key}" ${g.key === ex.muscleGroup ? 'selected' : ''}>${g.key}</option>`).join('')}
        </select>
        <input type="number" title="series" value="${ex.sets}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','sets',this.value)">
        <input type="text" title="reps (ej: 10 o 10-8-8-6)" placeholder="reps" value="${repsSchemeLabel(ex)}" onchange="App.wizardUpdateEx('${day.id}','${ex.id}','repsScheme',this.value)">
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
  routineWizard.days.find(d => d.id === dayId).exercises.push({ id: uid(), name: '', muscleGroup: 'Otro', sets: 4, repsScheme: [10], restSeconds: 90 });
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
  else if (field === 'repsScheme') ex.repsScheme = parseRepsSchemeInput(value);
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
    return `<div class="week-seg ${cls}"><div class="bar"></div><span>${w === weeks ? 'Descarga' : `Sem ${w}`}</span></div>`;
  }).join('');

  let html = `<div class="card coach-hero" style="margin-top:4px">
      <span class="phase-pill ${info.phase}">${icon(info.phase === 'descarga' ? 'flag' : 'bolt')} ${info.phase === 'descarga' ? 'Semana de descarga' : 'Semana de carga'}</span>
      <div class="week-track">${segs}</div>
      <p class="hint" style="margin-bottom:0">Bloque ${info.blockNumber} · semana ${info.weekNumber} de esta rutina.
        ${info.phase === 'carga' ? `Próxima descarga: <b>${formatDate(deload)}</b>.` : 'Bajá la intensidad y priorizá recuperar.'}</p>
      <div class="fatigue-meter"><span class="fatigue-dot ${overall.level.replace(' ', '')}"></span><span>${escapeHtml(overall.label)}</span></div>
    </div>`;

  for (const { day, items } of perDay) {
    if (!items.length) continue;
    html += `<div class="card flush"><h3 class="card-title">${escapeHtml(day.name)}</h3><div class="coach-list">`;
    for (const { ex, s: sug } of items) {
      const plannedReps = ex.repsScheme[ex.repsScheme.length - 1];
      html += `<div class="coach-row">
        <span class="fatigue-dot ${sug.fatigue.replace(' ', '')}" title="Fatiga ${sug.fatigue}"></span>
        <div class="cr-main">
          <div class="cr-name">${escapeHtml(ex.name)}</div>
          <div class="cr-meta"><span class="mg-chip ${muscleGroupClass(ex.muscleGroup)}">${escapeHtml(ex.muscleGroup)}</span>${ex.sets} × ${repsSchemeLabel(ex)}</div>
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
  if (!state.logs.length) { main.innerHTML = emptyState('chart', 'Tu progreso', 'Cuando registres series en la pestaña Hoy, acá vas a ver la evolución de cada ejercicio y grupo muscular.'); return; }

  let html = `<div class="segmented" style="margin-top:4px">
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
      <h2 style="font-size:15px;margin-top:18px">Diagnóstico de instalación</h2>
      <p class="hint">Versión ${APP_VERSION}. Si la app no se deja instalar, tocá el botón y mandá una captura de lo que aparece.</p>
      <button class="btn-secondary" onclick="App.runInstallDiagnostics()">Ver diagnóstico</button>
      <pre id="diagOutput" class="diag-output" hidden></pre>
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
  wizardRenameDay, wizardAddExercise, wizardRemoveEx, wizardUpdateEx, saveWizard,
  setProgressMode, setProgressGroup, setProgressExercise,
  openSettingsModal, closeModal, updateSetting, updateDeload, doExport, doImport,
  runInstallDiagnostics,
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

if (!state.selectedDayId) { const r = getActiveRoutine(state); state.selectedDayId = r?.days[0]?.id || null; }
render();
