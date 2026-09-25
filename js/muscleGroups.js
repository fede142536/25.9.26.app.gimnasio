/**
 * Grupos musculares: la lista fija que pediste (Pecho, Bíceps, Tríceps,
 * Piernas, Espalda, Hombros), con un color categórico fijo por grupo
 * (paleta validada del skill de dataviz — mismo orden en toda la app,
 * nunca se reasignan colores según el filtro activo). "Otro" es un
 * comodín para lo que no se puede clasificar automáticamente.
 *
 * El diccionario de palabras clave se usa para adivinar el grupo de un
 * ejercicio al importar una rutina. Es un punto de partida heurístico:
 * el usuario siempre puede corregirlo a mano. Para desambiguar (ej.
 * "Remo al mentón" es hombro, no espalda, aunque tenga "remo") se elige
 * siempre la palabra clave más específica (la más larga) que matchea,
 * no la primera del diccionario.
 */

export const MUSCLE_GROUPS = [
  { key: 'Pecho', slot: 1 },
  { key: 'Espalda', slot: 2 },
  { key: 'Piernas', slot: 3 },
  { key: 'Hombros', slot: 4 },
  { key: 'Bíceps', slot: 5 },
  { key: 'Tríceps', slot: 6 },
  { key: 'Otro', slot: 0 },
];

export function slotFor(muscleGroup) {
  return MUSCLE_GROUPS.find(g => g.key === muscleGroup)?.slot ?? 0;
}

export function muscleGroupClass(muscleGroup) {
  const slot = slotFor(muscleGroup);
  return slot ? `mg-${slot}` : 'mg-0';
}

/** tren superior (para el incremento de carga sugerido por el entrenador) vs. tren inferior */
export function isLowerBody(muscleGroup) {
  return muscleGroup === 'Piernas';
}

// Orden de las palabras dentro de cada grupo no importa: guessMuscleGroup
// elige siempre la coincidencia más específica (la de mayor longitud).
const KEYWORDS = [
  { group: 'Pecho', words: ['banco plano', 'press plano', 'press inclinado', 'press declinado', 'apertura', 'aperturas', 'peck deck', 'contractora', 'press pecho', 'press banca', 'flexiones', 'cruces en polea'] },
  { group: 'Espalda', words: ['remo', 'jalon', 'dominadas', 'pull up', 'pulldown', 'pullover', 'dorsalera', 'encogimiento', 'espalda', 'jalones', 'peso muerto convencional'] },
  { group: 'Piernas', words: ['sentadilla', 'prensa', 'zancada', 'estocada', 'cuadriceps', 'femoral', 'isquiotibial', 'gemelos', 'pantorrilla', 'hack squat', 'bulgara', 'aductor', 'abductor', 'gluteo', 'hip thrust', 'camilla', 'peso muerto'] },
  { group: 'Hombros', words: ['press militar', 'press hombro', 'press arnold', 'vuelos laterales', 'elevaciones laterales', 'elevacion frontal', 'face pull', 'pajaros', 'hombro', 'posteriores en polea', 'posteriores', 'remo al menton', 'deltoides'] },
  { group: 'Bíceps', words: ['curl biceps', 'curl con mancuernas', 'curl con barra', 'banco scott', 'predicador', 'biceps', 'curl martillo', 'curl'] },
  { group: 'Tríceps', words: ['triceps', 'press frances', 'fondos en paralelas', 'fondos', 'press estrecho', 'extension triceps', 'jalon de triceps', 'patada de triceps'] },
];

export function guessMuscleGroup(exerciseName) {
  const n = exerciseName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let best = null;
  for (const { group, words } of KEYWORDS) {
    for (const w of words) {
      if (n.includes(w) && (!best || w.length > best.word.length)) best = { group, word: w };
    }
  }
  return best ? best.group : 'Otro';
}
