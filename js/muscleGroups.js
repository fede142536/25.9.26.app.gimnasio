/**
 * Categorías (grupos musculares) editables por el usuario.
 *
 * La lista vive en state.categories: [{ name, slot }]. `slot` (1–8) es el
 * color categórico fijo de esa categoría (paleta validada del skill de
 * dataviz): se asigna al crearla y no cambia aunque se renombren o se
 * borren otras, así el color sigue siempre a la misma categoría. Por eso
 * el máximo es MAX_CATEGORIES: no se generan colores nuevos ni se repiten.
 *
 * El diccionario de palabras clave sirve para adivinar la categoría de un
 * ejercicio al importar una rutina. Solo se usan las entradas cuya
 * categoría existe; además, el propio nombre de cada categoría funciona
 * como palabra clave (si agregás "Glúteos", "Puente de glúteos" cae ahí).
 * Gana siempre la coincidencia más específica (la más larga): "Remo al
 * mentón" es Hombros aunque contenga "remo".
 */

export const MAX_CATEGORIES = 8;

// `base`: categoría original de la que viene; se conserva al renombrar, así
// "Piernas" renombrada a "Cuádriceps" sigue reconociendo "sentadilla", "prensa"…
export const DEFAULT_CATEGORIES = [
  { name: 'Pecho', slot: 1, base: 'Pecho' },
  { name: 'Espalda', slot: 2, base: 'Espalda' },
  { name: 'Piernas', slot: 3, base: 'Piernas' },
  { name: 'Hombros', slot: 4, base: 'Hombros' },
  { name: 'Bíceps', slot: 5, base: 'Bíceps' },
  { name: 'Tríceps', slot: 6, base: 'Tríceps' },
];

let categories = DEFAULT_CATEGORIES.map(c => ({ ...c }));

/** main.js la llama al cargar y cada vez que el usuario cambia las categorías. */
export function setCategories(list) { categories = list; }
export function getCategories() { return categories; }

export function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function findCategory(name) {
  const n = norm(name);
  return categories.find(c => norm(c.name) === n) || null;
}

export function slotFor(muscleGroup) { return findCategory(muscleGroup)?.slot ?? 0; }

export function muscleGroupClass(muscleGroup) {
  const slot = slotFor(muscleGroup);
  return slot ? `mg-${slot}` : 'mg-0';
}

/** Primer color libre para una categoría nueva (null si ya se usaron los 8). */
export function freeSlot() {
  const used = new Set(categories.map(c => c.slot));
  for (let s = 1; s <= MAX_CATEGORIES; s++) if (!used.has(s)) return s;
  return null;
}

/** Tren inferior recibe un incremento de carga mayor al progresar. */
export function isLowerBody(muscleGroup) {
  return /pierna|glute|cuadricep|isquio|gemelo|pantorrilla/.test(norm(muscleGroup));
}

const KEYWORDS = [
  { group: 'Pecho', words: ['banco plano', 'press plano', 'press inclinado', 'press declinado', 'apertura', 'aperturas', 'peck deck', 'contractora', 'press pecho', 'press banca', 'flexiones', 'cruces en polea', 'pecho'] },
  { group: 'Espalda', words: ['remo', 'jalon', 'dominadas', 'pull up', 'pulldown', 'pullover', 'dorsalera', 'encogimiento', 'espalda', 'jalones', 'peso muerto convencional'] },
  { group: 'Piernas', words: ['sentadilla', 'prensa', 'zancada', 'estocada', 'cuadriceps', 'femoral', 'isquiotibial', 'gemelos', 'pantorrilla', 'hack squat', 'bulgara', 'aductor', 'abductor', 'gluteo', 'hip thrust', 'camilla', 'peso muerto', 'pierna'] },
  { group: 'Hombros', words: ['press militar', 'press hombro', 'press arnold', 'vuelos laterales', 'elevaciones laterales', 'elevacion frontal', 'face pull', 'pajaros', 'hombro', 'posteriores en polea', 'posteriores', 'remo al menton', 'deltoides'] },
  { group: 'Bíceps', words: ['curl biceps', 'curl con mancuernas', 'curl con barra', 'banco scott', 'predicador', 'biceps', 'curl martillo', 'curl'] },
  { group: 'Tríceps', words: ['triceps', 'press frances', 'fondos en paralelas', 'fondos', 'press estrecho', 'extension triceps', 'jalon de triceps', 'patada de triceps'] },
];

/** Categoría más probable para un texto (nombre de ejercicio o de día), o null si no hay pistas. */
export function guessMuscleGroup(text) {
  const n = norm(text);
  let best = null;
  const consider = (catName, word) => {
    if (word && n.includes(word) && (!best || word.length > best.word.length)) best = { name: catName, word };
  };
  for (const { group, words } of KEYWORDS) {
    const cat = categories.find(c => c.base === group) || findCategory(group);
    if (cat) for (const w of words) consider(cat.name, w);
  }
  for (const cat of categories) {
    const w = norm(cat.name);
    consider(cat.name, w);
    if (w.endsWith('s')) consider(cat.name, w.slice(0, -1)); // "gluteos" → también "gluteo"
  }
  return best ? best.name : null;
}
