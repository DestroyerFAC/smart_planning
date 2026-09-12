/**
 * Rapprochement des noms de personnes entre deux imports.
 *
 * Probleme concret : la meme personne apparait comme "DUPONT Jean" sur le
 * planning de septembre, "Jean DUPONT" sur celui d'octobre, et "J. Dupond"
 * quand l'OCR se trompe d'une lettre. Sans rapprochement, chaque import
 * creerait un nouveau collegue et le calendrier se remplirait de doublons.
 *
 * La strategie est volontairement conservatrice : on prefere laisser deux
 * fiches separees (que l'utilisateur peut fusionner a la main) plutot que de
 * fusionner a tort deux collegues differents, ce qui corromprait le planning.
 */
import { fnv1a } from '../lib/hash';
import type { Person } from '../types';

/** Seuil au-dela duquel deux noms sont consideres comme la meme personne. */
export const MATCH_THRESHOLD = 0.82;

/** Particules ignorees lors du rapprochement : elles n'apportent aucun signal. */
const PARTICLES = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'van', 'von', 'da', 'di', 'el']);

/** Plage des diacritiques combinants Unicode, retires apres normalisation NFD. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Minuscules, sans accent, sans ponctuation. Etape commune a tout le module. */
function deburr(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Tokens signifiants d'un nom, particules retirees. */
export function nameTokens(raw: string): string[] {
  return deburr(raw)
    .split(' ')
    .filter((t) => t.length > 0 && !PARTICLES.has(t));
}

/**
 * Cle de rapprochement stable : tokens tries alphabetiquement.
 * L'ordre nom/prenom devient ainsi sans importance.
 */
export function normalizeName(raw: string): string {
  return nameTokens(raw).sort().join(' ');
}

/** Identifiant deterministe : le meme nom donne toujours le meme id. */
export function personIdFromName(raw: string): string {
  return `p_${fnv1a(normalizeName(raw))}`;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr: number[] = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] as number;
}

/** Similarite 0..1 entre deux chaines, derivee de la distance d'edition. */
function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

/**
 * Score de correspondance entre deux tokens isoles.
 * Gere explicitement le cas de l'initiale ("j" vs "jean"), tres frequent sur
 * les plannings imprimes ou la colonne des noms est etroite.
 */
function tokenScore(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 1 || b.length === 1) {
    const initial = a.length === 1 ? a : b;
    const full = a.length === 1 ? b : a;
    return full.startsWith(initial) ? 0.9 : 0;
  }
  const sim = editSimilarity(a, b);
  // Sous 0.75 il s'agit presque surement de deux mots differents, pas d'une faute d'OCR.
  return sim >= 0.75 ? sim : 0;
}

/**
 * Similarite globale entre deux noms, dans [0, 1].
 *
 * Chaque token du nom le plus court cherche son meilleur partenaire dans
 * l'autre nom (appariement glouton, sans reutilisation). Le score final est
 * la moyenne de ces appariements, penalisee quand un nom contient nettement
 * plus de tokens que l'autre.
 */
export function nameSimilarity(rawA: string, rawB: string): number {
  const a = nameTokens(rawA);
  const b = nameTokens(rawB);
  if (a.length === 0 || b.length === 0) return 0;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const taken = new Set<number>();
  let total = 0;

  for (const token of shorter) {
    let bestScore = 0;
    let bestIndex = -1;
    for (let i = 0; i < longer.length; i += 1) {
      if (taken.has(i)) continue;
      const score = tokenScore(token, longer[i] as string);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) taken.add(bestIndex);
    total += bestScore;
  }

  const base = total / shorter.length;
  // Un nom de 1 token face a un nom de 3 reste ambigu : on amortit le score.
  const lengthPenalty = shorter.length / longer.length;
  return base * (0.7 + 0.3 * lengthPenalty);
}

export interface NameMatch {
  readonly person: Person;
  readonly score: number;
}

/**
 * Cherche la personne existante correspondant a `rawName`.
 *
 * Renvoie `null` si aucune ne depasse le seuil, OU si les deux meilleures
 * candidates sont trop proches l'une de l'autre : dans ce cas le choix serait
 * arbitraire, et creer une nouvelle fiche est le moindre mal.
 */
export function findMatchingPerson(
  rawName: string,
  people: readonly Person[],
): NameMatch | null {
  const normalized = normalizeName(rawName);
  if (normalized.length === 0) return null;

  const exact = people.find((p) => p.normalizedName === normalized);
  if (exact) return { person: exact, score: 1 };

  const ranked = people
    .map((person) => ({ person, score: nameSimilarity(rawName, person.displayName) }))
    .sort((x, y) => y.score - x.score);

  const best = ranked[0];
  if (!best || best.score < MATCH_THRESHOLD) return null;

  const runnerUp = ranked[1];
  if (runnerUp && best.score - runnerUp.score < 0.05) return null;

  return best;
}

/**
 * Choisit la plus lisible parmi les graphies rencontrees pour une personne.
 * Prefere la forme la plus complete, puis la casse mixte a "TOUT EN MAJUSCULES".
 */
export function prettiestName(candidates: readonly string[]): string {
  const cleaned = candidates.map((c) => c.trim()).filter((c) => c.length > 0);
  if (cleaned.length === 0) return '';

  const best = cleaned.reduce((acc, candidate) => {
    // La completude se mesure en CARACTERES significatifs, pas en nombre de
    // tokens : "J. Dupont" et "Jean Dupont" ont tous deux deux tokens, mais
    // seul le second porte le prenom en entier.
    const accWeight = informationWeight(acc);
    const candWeight = informationWeight(candidate);
    if (candWeight !== accWeight) return candWeight > accWeight ? candidate : acc;

    const accUpper = acc === acc.toUpperCase();
    const candUpper = candidate === candidate.toUpperCase();
    if (accUpper !== candUpper) return accUpper ? candidate : acc;
    return acc;
  });

  return best === best.toUpperCase() ? toTitleCase(best) : best;
}

/** Quantite d'information portee par un nom : total des lettres utiles. */
function informationWeight(value: string): number {
  return nameTokens(value).reduce((total, token) => total + token.length, 0);
}

function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(
      /(^|[\s'-])(\p{Ll})/gu,
      (_, separator: string, letter: string) => separator + letter.toUpperCase(),
    );
}

/** Couleur HSL stable derivee de l'id : la meme personne garde sa couleur. */
export function colorForPerson(personId: string): string {
  const hue = parseInt(fnv1a(personId), 36) % 360;
  return `hsl(${hue} 62% 45%)`;
}
