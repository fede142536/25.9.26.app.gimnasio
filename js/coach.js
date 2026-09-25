/**
 * Motor de periodización — el "entrenador personal" automático.
 *
 * Reglas simples y transparentes (no es asesoramiento médico ni reemplaza
 * a un entrenador real; son heurísticas de sobrecarga progresiva estándar):
 *
 * 1. El programa se divide en bloques de `mesocycleWeeks` semanas. La
 *    última semana de cada bloque es siempre una semana de descarga
 *    (menos peso y/o volumen) para permitir recuperar antes de seguir.
 * 2. Fuera de la semana de descarga, si en la última sesión de un
 *    ejercicio se cumplieron todas las series con las repeticiones
 *    objetivo, se sugiere subir el peso (progresión). Si no se cumplieron,
 *    se sugiere mantener el peso. Si hay caídas repetidas de rendimiento
 *    en las últimas sesiones, se marca fatiga alta y se sugiere sostener
 *    o bajar levemente en vez de forzar la progresión.
 * 3. En la semana de descarga se sugiere un peso reducido (deloadFactor)
 *    sobre el último peso de una semana de carga, independientemente del
 *    punto 2.
 * 4. Las sesiones hechas en semanas de descarga no cuentan como base para
 *    progresar ni para medir fatiga (son livianas a propósito). Si solo
 *    hay sesiones de descarga (por ejemplo, empezaste a usar la app en
 *    una semana de descarga), el peso habitual se estima deshaciendo la
 *    reducción de la descarga.
 *
 * El usuario puede indicar en qué semana del bloque está: eso mueve
 * `routine.cycleStartDate` (el inicio del bloque actual), sin tocar la
 * fecha de inicio de la rutina.
 */

import { daysBetween, normalizeName } from './state.js';
import { isLowerBody } from './muscleGroups.js';

/** Semana/bloque/fase del programa para una fecha dada. */
export function weekInfo(routine, dateISO, settings) {
  if (!routine) return null;
  const diff = daysBetween(routine.cycleStartDate || routine.startDate, dateISO);
  const weekNumber = Math.max(1, Math.floor(Math.max(diff, 0) / 7) + 1);
  const weekInBlock = ((weekNumber - 1) % settings.mesocycleWeeks) + 1;
  const blockNumber = Math.floor((weekNumber - 1) / settings.mesocycleWeeks) + 1;
  const phase = weekInBlock === settings.mesocycleWeeks ? 'descarga' : 'carga';
  return { weekNumber, weekInBlock, blockNumber, phase };
}

/** Fecha de inicio del ciclo para que `dateISO` caiga en la semana `weekInBlock` del bloque. */
export function cycleStartForWeek(dateISO, weekInBlock) {
  const d = new Date(dateISO + 'T00:00:00');
  d.setDate(d.getDate() - (weekInBlock - 1) * 7);
  return d.toISOString().slice(0, 10);
}

/** Próxima fecha (ISO) en la que empieza la siguiente semana de descarga. */
export function nextDeloadDate(routine, settings, fromISO) {
  const info = weekInfo(routine, fromISO, settings);
  if (!info) return null;
  const weeksUntilDeload = settings.mesocycleWeeks - info.weekInBlock;
  const d = new Date(fromISO + 'T00:00:00');
  d.setDate(d.getDate() + weeksUntilDeload * 7);
  return d.toISOString().slice(0, 10);
}

/** Agrupa los logs de un ejercicio (por exerciseKey) en sesiones (una por fecha). */
function sessionsFor(logs, exerciseKey) {
  const byDate = new Map();
  for (const l of logs) {
    if (l.exerciseKey !== exerciseKey) continue;
    if (!byDate.has(l.date)) byDate.set(l.date, []);
    byDate.get(l.date).push(l);
  }
  return Array.from(byDate.entries())
    .sort((a, b) => b[0].localeCompare(a[0])) // más reciente primero
    .map(([date, sets]) => ({
      date,
      sets: sets.sort((a, b) => a.setNumber - b.setNumber),
      deload: sets.some(l => l.phase === 'descarga'),
    }));
}

/** ¿Qué fracción de las series de una sesión llegó a la meta de reps? */
function repsMetRatio(session, plannedReps) {
  if (!session.sets.length) return 0;
  const target = plannedReps || Math.max(...session.sets.map(s => s.reps));
  const met = session.sets.filter(s => s.reps >= target).length;
  return met / session.sets.length;
}

/**
 * Sugerencia para un ejercicio concreto de la rutina activa.
 * `plannedReps`/`muscleGroup` vienen de la definición del ejercicio en la rutina.
 */
export function suggestForExercise({ exerciseName, muscleGroup, plannedReps }, logs, settings, phase) {
  const key = normalizeName(exerciseName);
  const sessions = sessionsFor(logs, key);
  const loadSessions = sessions.filter(s => !s.deload);
  const deloadSessions = sessions.filter(s => s.deload);
  const topWeight = (session) => Math.max(...session.sets.map(s => s.weight));
  const pct = Math.round((1 - settings.deloadFactor) * 100);

  // fatiga: sesiones de carga (de las últimas 3) que no llegaron a la mitad de las series con la meta de reps
  const recent = loadSessions.slice(0, 3);
  const strugglingSessions = recent.filter(s => repsMetRatio(s, plannedReps) < 0.5).length;
  const fatigue = !loadSessions.length ? 'sin datos' : strugglingSessions >= 2 ? 'alta' : strugglingSessions === 1 ? 'media' : 'baja';

  if (phase === 'descarga') {
    if (loadSessions.length) {
      return {
        suggestedWeight: roundToHalf(topWeight(loadSessions[0]) * settings.deloadFactor),
        suggestedReps: plannedReps,
        fatigue,
        note: `Semana de descarga: ${pct}% menos que tu último peso de carga, para recuperar antes del próximo bloque.`,
      };
    }
    if (deloadSessions.length) {
      return {
        suggestedWeight: topWeight(deloadSessions[0]),
        suggestedReps: plannedReps,
        fatigue,
        note: 'Semana de descarga: repetí el peso liviano que ya usaste esta semana.',
      };
    }
    return {
      suggestedWeight: null, suggestedReps: plannedReps, fatigue,
      note: `Descarga: usá ~${pct}% menos de tu peso habitual, o lo que te indique tu entrenador.`,
    };
  }

  if (!loadSessions.length) {
    if (deloadSessions.length && topWeight(deloadSessions[0]) > 0) {
      // Deshacemos la reducción de la descarga, redondeando hacia abajo a 2,5 kg para no pasarse.
      const estimate = Math.floor(topWeight(deloadSessions[0]) / settings.deloadFactor / 2.5) * 2.5;
      return {
        suggestedWeight: estimate,
        suggestedReps: plannedReps,
        fatigue,
        note: 'Volvés de la descarga: este es tu peso habitual estimado. Ajustalo si no coincide.',
      };
    }
    return { suggestedWeight: null, suggestedReps: plannedReps, fatigue: 'sin datos', note: 'Registrá tu primera serie para que pueda sugerirte una carga.' };
  }

  const last = loadSessions[0];
  const lastTopWeight = topWeight(last);
  const ratio = repsMetRatio(last, plannedReps);

  if (ratio === 1 && fatigue !== 'alta') {
    const increment = isLowerBody(muscleGroup) ? settings.incrementLower : settings.incrementUpper;
    if (lastTopWeight > 0) {
      return {
        suggestedWeight: roundToHalf(lastTopWeight + increment),
        suggestedReps: plannedReps,
        fatigue,
        note: `Cerraste todas las series con la meta de reps: subí ${String(increment).replace('.', ',')} kg.`,
      };
    }
    return {
      suggestedWeight: 0,
      suggestedReps: (plannedReps || last.sets[0].reps) + settings.repIncrement,
      fatigue,
      note: `Sin peso adicional: sumá ${settings.repIncrement} repetición(es) más por serie.`,
    };
  }

  if (fatigue === 'alta') {
    return {
      suggestedWeight: roundToHalf(lastTopWeight * 0.9),
      suggestedReps: plannedReps,
      fatigue,
      note: 'Viniste bajando el rendimiento en las últimas sesiones: bajá un poco la carga y priorizá técnica y descanso.',
    };
  }

  return {
    suggestedWeight: lastTopWeight,
    suggestedReps: plannedReps,
    fatigue,
    note: 'Todavía no cerraste todas las series con la meta de reps: mantené el mismo peso hasta lograrlo.',
  };
}

/** Señal global de fatiga a partir de los ejercicios de la rutina activa. */
export function overallFatigue(exerciseSuggestions) {
  const withData = exerciseSuggestions.filter(s => s.fatigue !== 'sin datos');
  if (!withData.length) return { level: 'sin datos', label: 'Sin datos suficientes todavía' };
  const altas = withData.filter(s => s.fatigue === 'alta').length;
  const medias = withData.filter(s => s.fatigue === 'media').length;
  const ratio = (altas + medias * 0.5) / withData.length;
  if (ratio >= 0.4) return { level: 'alta', label: 'Fatiga alta: considerá adelantar la descarga o bajar volumen' };
  if (ratio >= 0.15) return { level: 'media', label: 'Fatiga moderada: prestá atención a la técnica' };
  return { level: 'baja', label: 'Buena recuperación general' };
}

function roundToHalf(n) { return Math.round(n * 2) / 2; }
