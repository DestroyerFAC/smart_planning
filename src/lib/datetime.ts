/**
 * Utilitaires de date/heure.
 *
 * Regle absolue du projet : un planning est une donnee LOCALE. On ne manipule
 * jamais d'instant UTC, uniquement des dates civiles ("2026-09-12") et des
 * heures murales ("08:30"). Passer par `new Date(isoString)` decalerait les
 * journees d'une heure selon le fuseau et l'heure d'ete — bug classique et
 * tres penible a diagnostiquer sur un calendrier.
 */
import type { HHMM, ISODate } from '../types';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidISODate(value: string): value is ISODate {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = parseISODate(value);
  // Rejette les dates impossibles type "2026-02-31" que la regex laisse passer.
  return parsed !== null && toISODate(parsed) === value;
}

export function isValidHHMM(value: string): value is HHMM {
  return HHMM_RE.test(value);
}

/** Date -> "2026-09-12", en composantes LOCALES (jamais toISOString). */
export function toISODate(date: Date): ISODate {
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** "2026-09-12" -> Date locale a minuit. `null` si la chaine est malformee. */
export function parseISODate(value: string): Date | null {
  if (!ISO_DATE_RE.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function todayISO(): ISODate {
  return toISODate(new Date());
}

/** Decale une date ISO d'un nombre de jours, sans passer par les millisecondes. */
export function addDaysISO(value: ISODate, days: number): ISODate {
  const date = parseISODate(value);
  if (!date) return value;
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

/** Toutes les dates de `start` a `end` incluses. Borne a 400 jours par securite. */
export function datesBetween(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  if (!isValidISODate(start) || !isValidISODate(end) || start > end) return out;
  let cursor = start;
  // Garde-fou : une plage aberrante renvoyee par le modele ne doit pas figer l'UI.
  for (let guard = 0; cursor <= end && guard < 400; guard += 1) {
    out.push(cursor);
    cursor = addDaysISO(cursor, 1);
  }
  return out;
}

/**
 * Normalise une heure ecrite librement vers "HH:MM".
 * Accepte "8h", "8h30", "8:30", "08.30", "0830", "8 h 30".
 * Renvoie `null` si la chaine n'est pas une heure exploitable.
 */
export function normalizeTime(raw: string | null | undefined): HHMM | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (cleaned.length === 0) return null;

  const match = cleaned.match(/^(\d{1,2})(?:[h:.,](\d{0,2}))?$/) ?? cleaned.match(/^(\d{2})(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutesRaw = match[2];
  const minutes = minutesRaw === undefined || minutesRaw === '' ? 0 : Number(minutesRaw);

  if (!Number.isInteger(hours) || hours > 23) return null;
  if (!Number.isInteger(minutes) || minutes > 59) return null;

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/** "08:30" -> 510. Utilise pour positionner les blocs dans la vue semaine. */
export function minutesOfDay(time: HHMM): number {
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  return hours * 60 + minutes;
}

/**
 * Duree d'un poste en minutes, en gerant le passage de minuit.
 * Un poste 22:00 -> 06:00 dure 8 h, pas -16 h.
 */
export function shiftDurationMinutes(start: HHMM, end: HHMM): number {
  const from = minutesOfDay(start);
  const to = minutesOfDay(end);
  return to >= from ? to - from : to + 24 * 60 - from;
}

/** Vrai si le poste se termine le lendemain (poste de nuit). */
export function crossesMidnight(start: HHMM, end: HHMM): boolean {
  return minutesOfDay(end) < minutesOfDay(start);
}

/** Debut de la semaine contenant `value`, selon le premier jour configure. */
export function startOfWeekISO(value: ISODate, weekStartsOn: 0 | 1): ISODate {
  const date = parseISODate(value);
  if (!date) return value;
  const delta = (date.getDay() - weekStartsOn + 7) % 7;
  return addDaysISO(value, -delta);
}

/** Premier jour du mois contenant `value`. */
export function startOfMonthISO(value: ISODate): ISODate {
  return `${value.slice(0, 7)}-01`;
}

/** Dernier jour du mois contenant `value`. */
export function endOfMonthISO(value: ISODate): ISODate {
  const date = parseISODate(value);
  if (!date) return value;
  // Jour 0 du mois suivant = dernier jour du mois courant.
  return toISODate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

/** Decale un mois, en gardant le premier jour (evite les debordements du 31). */
export function addMonthsISO(value: ISODate, months: number): ISODate {
  const date = parseISODate(startOfMonthISO(value));
  if (!date) return value;
  date.setMonth(date.getMonth() + months);
  return toISODate(date);
}
