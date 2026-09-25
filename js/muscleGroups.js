/**
 * Grupos musculares: lista fija, con un color categórico fijo por grupo
 * (paleta validada del skill de dataviz — mismo orden en toda la app,
 * nunca se reasignan colores según el filtro activo).
 *
 * También un diccionario de palabras clave en español para adivinar el
 * grupo muscular de un ejercicio al importar una rutina. Es un punto de
 * partida heurístico: el usuario siempre puede corregirlo a mano.
 */

export const MUSCLE_GROUPS = [
  { key: 'Pecho', slot: 1 },
  { key: 'Espalda', slot: 2 },
  { key: 'Piernas', slot: 3 },
  { key: 'Hombros', slot: 4 },
  { key: 'Brazos', slot: 5 },
  { key: 'Core', slot: 6 },
  { key: 'Glúteos', slot: 7 },
  { key: 'Cardio', slot: 8 },
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
  return muscleGroup === 'Piernas' || muscleGroup === 'Glúteos';
}

const KEYWORDS = [
  { group: 'Pecho', words: ['press banca', 'press plano', 'press inclinado', 'press declinado', 'aperturas', 'pullover', 'flexiones', 'press pecho', 'peck deck', 'contractora'] },
  { group: 'Espalda', words: ['remo', 'jalon', 'dominadas', 'pull up', 'pulldown', 'peso muerto', 'espalda', 'lat', 'encogimientos'] },
  { group: 'Piernas', words: ['sentadilla', 'prensa', 'zancada', 'estocada', 'cuadriceps', 'femoral', 'extension de pierna', 'curl femoral', 'gemelos', 'pantorrilla', 'hack squat', 'bulgara'] },
  { group: 'Glúteos', words: ['hip thrust', 'gluteo', 'patada de gluteo', 'puente de gluteo', 'abduccion'] },
  { group: 'Hombros', words: ['press militar', 'press hombro', 'elevaciones laterales', 'elevacion frontal', 'press arnold', 'face pull', 'pajaros', 'hombro'] },
  { group: 'Brazos', words: ['curl biceps', 'curl martillo', 'triceps', 'press frances', 'fondos', 'biceps', 'extension de triceps', 'jalon de triceps', 'predicador', 'curl'] },
  { group: 'Core', words: ['plancha', 'crunch', 'abdominales', 'elevacion de piernas', 'core', 'rueda abdominal', 'oblicuos'] },
  { group: 'Cardio', words: ['cardio', 'cinta', 'bicicleta', 'eliptica', 'correr', 'caminadora', 'remo ergometro', 'escaladora'] },
];

export function guessMuscleGroup(exerciseName) {
  const n = exerciseName
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  // "curl femoral" y "peso muerto" son ambiguos: los resolvemos antes del resto
  for (const { group, words } of KEYWORDS) {
    for (const w of words) {
      if (n.includes(w)) return group;
    }
  }
  return 'Otro';
}
