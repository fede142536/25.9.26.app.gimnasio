/**
 * Timer de descanso entre series: cuenta regresiva con beep + vibración al
 * llegar a cero. Un solo timer activo a la vez (el de la serie que se acaba
 * de registrar); `onTick` se llama en cada segundo para poder re-renderizar.
 */

let intervalId = null;
export const restTimer = { active: false, secondsLeft: 0, total: 0, exerciseName: '' };

export function startRest(seconds, exerciseName, onTick) {
  clearInterval(intervalId);
  restTimer.active = true;
  restTimer.secondsLeft = seconds;
  restTimer.total = seconds;
  restTimer.exerciseName = exerciseName;
  intervalId = setInterval(() => {
    restTimer.secondsLeft--;
    if (restTimer.secondsLeft <= 0) {
      clearInterval(intervalId);
      restTimer.active = false;
      vibrate([200, 100, 200]);
      playBeep();
    }
    onTick();
  }, 1000);
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
  restTimer.secondsLeft = Math.max(1, restTimer.secondsLeft + seconds);
  restTimer.total = Math.max(restTimer.total, restTimer.secondsLeft);
  onTick();
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
