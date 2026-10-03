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
 *
 * Para que el descanso se vea en la pantalla de bloqueo (sin eso, un
 * timer dentro de una pestaña no se puede mostrar ahí) se usa la Media
 * Session API: se reproduce un audio casi inaudible en loop — el truco
 * habitual para esto, ya que la mayoría de los sistemas solo arman el
 * panel de "reproduciendo ahora" mientras hay audio sonando, y algunos
 * (Chrome en particular) ignoran un audio con silencio DIGITAL total
 * (todas las muestras en 0), así que se usa una amplitud mínima en vez
 * de ceros — y se le pasa duración/posición con `setPositionState`, así
 * el propio sistema dibuja y mueve la barra de progreso aunque la
 * pestaña esté en segundo plano y el JS no pueda correr. Se puede
 * desactivar (`restOnLockScreen` en ajustes) para quien no quiera un
 * control de audio persistente mientras entrena.
 *
 * Importante: si "Mantener la pantalla encendida" está activo, el
 * celular no llega a bloquearse mientras se está en "Hoy" — hay que
 * bloquearlo a mano (botón de encendido) para ver esto en acción.
 */

let intervalId = null;
let lockScreenEnabled = true;
let lastOnTick = () => {};
let audioEl = null;
export const restTimer = { active: false, endsAt: 0, total: 0, secondsLeft: 0, exerciseName: '', kind: 'sets' };

/** Un WAV mono casi inaudible (amplitud mínima, no silencio digital puro), generado en el momento. */
function silentAudio() {
  if (audioEl) return audioEl;
  const sampleRate = 8000;
  const seconds = 2;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2; // 16 bits = 2 bytes por muestra
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);
  // onda cuadrada de amplitud 2 (sobre 32767) a la frecuencia de Nyquist: inaudible, pero no son todas muestras
  // en cero — eso es lo que algunos navegadores necesitan para no tratarlo como "sin audio real".
  for (let i = 0; i < numSamples; i++) view.setInt16(44 + i * 2, i % 2 === 0 ? 2 : -2, true);
  audioEl = new Audio(URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' })));
  audioEl.loop = true;
  audioEl.volume = 1;
  audioEl.setAttribute('playsinline', ''); // no pasar a pantalla completa en iOS
  audioEl.style.display = 'none';
  document.body.appendChild(audioEl); // algunos navegadores solo arman la sesión de medios con el audio en el DOM
  return audioEl;
}

function stopSilentAudio() {
  if (!audioEl) return;
  audioEl.pause();
  try { audioEl.currentTime = 0; } catch (e) { /* algún navegador lo niega antes de poder reproducir una vez */ }
}

let lastPlayError = null;
/** Intenta reproducir el audio silencioso y guarda el motivo si el navegador lo rechaza (para el diagnóstico). */
function tryPlayAudio() {
  const p = silentAudio().play();
  if (p && typeof p.then === 'function') {
    p.then(() => { lastPlayError = null; }).catch((e) => { lastPlayError = `${e.name}: ${e.message}`; });
  } else {
    lastPlayError = null;
  }
}

let mediaActionsReady = false;
function setupMediaSessionActions() {
  if (mediaActionsReady || !('mediaSession' in navigator)) return;
  mediaActionsReady = true;
  const skip = () => skipRest(lastOnTick);
  const resume = () => { if (restTimer.active) tryPlayAudio(); };
  for (const [action, handler] of [['play', resume], ['pause', resume], ['stop', skip], ['nexttrack', skip]]) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) { /* esa acción no existe en este navegador */ }
  }
}

/** Metadatos + posición para que el sistema dibuje el descanso (y su avance) en la pantalla de bloqueo. */
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    if (restTimer.active) {
      const title = restTimer.kind === 'exercise' ? `Antes de: ${restTimer.exerciseName}` : `Descanso · ${restTimer.exerciseName}`;
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Gimnasio' });
      navigator.mediaSession.playbackState = 'playing';
      const position = Math.min(restTimer.total, Math.max(0, restTimer.total - restTimer.secondsLeft));
      navigator.mediaSession.setPositionState({ duration: restTimer.total, playbackRate: 1, position });
    } else {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setPositionState();
    }
  } catch (e) { /* MediaMetadata/setPositionState no soportados en este navegador: no es crítico */ }
}

/** Activa o desactiva mostrar el descanso en la pantalla de bloqueo (ajuste del usuario). */
export function setLockScreenEnabled(enabled) {
  lockScreenEnabled = enabled;
  if (!enabled) { stopSilentAudio(); updateMediaSession(); }
}

/** Estado actual del truco de la pantalla de bloqueo, para el panel de diagnóstico (ver qué falla en el dispositivo real). */
export function lockScreenDebugInfo() {
  return {
    ajusteActivado: lockScreenEnabled,
    mediaSessionSoportada: 'mediaSession' in navigator,
    setPositionStateSoportado: typeof navigator.mediaSession?.setPositionState === 'function',
    descansoActivo: restTimer.active,
    audioCreado: !!audioEl,
    audioPausado: audioEl ? audioEl.paused : null,
    audioEnElDOM: audioEl ? document.body.contains(audioEl) : null,
    ultimoErrorDeReproduccion: lastPlayError,
  };
}

function tick(onTick) {
  restTimer.secondsLeft = Math.max(0, Math.ceil((restTimer.endsAt - Date.now()) / 1000));
  if (restTimer.secondsLeft <= 0 && restTimer.active) {
    clearInterval(intervalId);
    restTimer.active = false;
    vibrate([200, 100, 200]);
    playBeep();
    stopSilentAudio();
    updateMediaSession();
  } else if (restTimer.active && lockScreenEnabled && audioEl && audioEl.paused) {
    // el sistema puede pausar el audio por su cuenta (foco de audio, ahorro de batería, etc.);
    // sin esto, el control de la pantalla de bloqueo se queda "vivo" pero en silencio y deja de servir.
    tryPlayAudio();
  }
  onTick();
}

/** `kind`: 'sets' (descanso entre series del mismo ejercicio) o 'exercise' (al pasar al siguiente ejercicio). */
export function startRest(seconds, exerciseName, onTick, kind = 'sets') {
  clearInterval(intervalId);
  restTimer.active = true;
  restTimer.total = seconds;
  restTimer.endsAt = Date.now() + seconds * 1000;
  restTimer.secondsLeft = seconds;
  restTimer.exerciseName = exerciseName;
  restTimer.kind = kind;
  lastOnTick = onTick;
  if (lockScreenEnabled) {
    setupMediaSessionActions();
    tryPlayAudio(); // necesita el gesto del usuario que ya disparó este registro de serie
    updateMediaSession();
  }
  intervalId = setInterval(() => tick(onTick), 250);
  onTick();
}

export function skipRest(onTick) {
  clearInterval(intervalId);
  restTimer.active = false;
  stopSilentAudio();
  updateMediaSession();
  onTick();
}

/** Suma (o resta, con un valor negativo) segundos al descanso en curso. */
export function addRestTime(seconds, onTick) {
  if (!restTimer.active) return;
  restTimer.endsAt = Math.max(Date.now() + 1000, restTimer.endsAt + seconds * 1000);
  restTimer.total = Math.max(restTimer.total, Math.ceil((restTimer.endsAt - Date.now()) / 1000));
  tick(onTick); // recalcula secondsLeft primero: la posición que mandamos a la pantalla de bloqueo depende de él
  updateMediaSession();
}

/** Recalcula el tiempo restante ya (llamar al volver de segundo plano). No hace nada si no hay descanso activo. */
export function resyncRest(onTick) {
  if (!restTimer.active) return;
  lastOnTick = onTick;
  tick(onTick);
  updateMediaSession();
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
