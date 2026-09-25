/**
 * Timer de descanso entre series.
 *
 * Se ancla a la hora en que debería terminar (`endsAt`), no a "quedan N
 * segundos": así, si el celular se bloquea o el navegador pausa la
 * pestaña en segundo plano (algo habitual en Android/iOS para ahorrar
 * batería, y que frena un `setInterval` común), al volver el tiempo
 * restante se recalcula bien en vez de haber quedado congelado.
 * `resyncRest` se llama al volver a la app (Page Visibility) para forzar
 * ese recálculo inmediato, incluso si el descanso ya terminó estando en
 * segundo plano (ahí recién se avisa con sonido y vibración).
 */

let intervalId = null;
export const restTimer = { active: false, endsAt: 0, total: 0, secondsLeft: 0, exerciseName: '' };

function tick(onTick) {
  restTimer.secondsLeft = Math.max(0, Math.ceil((restTimer.endsAt - Date.now()) / 1000));
  if (restTimer.secondsLeft <= 0 && restTimer.active) {
    clearInterval(intervalId);
    restTimer.active = false;
    vibrate([200, 100, 200]);
    playBeep();
  }
  onTick();
}

export function startRest(seconds, exerciseName, onTick) {
  clearInterval(intervalId);
  restTimer.active = true;
  restTimer.total = seconds;
  restTimer.endsAt = Date.now() + seconds * 1000;
  restTimer.secondsLeft = seconds;
  restTimer.exerciseName = exerciseName;
  intervalId = setInterval(() => tick(onTick), 250);
  onTick();
}

export function skipRest(onTick) {
  clearInterval(intervalId);
  restTimer.active = false;
  onTick();
}

/** Suma (o resta, con un valor negativo) segundos al descanso en curso. */
export function addRestTime(seconds, onTick) {
  if (!restTimer.active) return;
  restTimer.endsAt = Math.max(Date.now() + 1000, restTimer.endsAt + seconds * 1000);
  restTimer.total = Math.max(restTimer.total, Math.ceil((restTimer.endsAt - Date.now()) / 1000));
  tick(onTick);
}

/** Recalcula el tiempo restante ya (llamar al volver de segundo plano). No hace nada si no hay descanso activo. */
export function resyncRest(onTick) {
  if (!restTimer.active) return;
  tick(onTick);
}

/** Beep corto con Web Audio API, sin archivos externos. */
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.55);
  } catch (e) { /* audio bloqueado hasta una interacción del usuario; no es crítico */ }
}

function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* no soportado */ }
}
