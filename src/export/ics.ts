/**
 * Generation de fichiers iCalendar (RFC 5545).
 *
 * C'est le pont vers l'ecran d'accueil de l'iPhone : une webapp ne peut pas
 * fournir de widget WidgetKit, mais le planning exporte ici s'ajoute au
 * Calendrier iOS, et le widget NATIF Calendrier l'affiche alors comme
 * n'importe quel autre agenda.
 *
 * Choix technique important : les heures sont ecrites en "floating time"
 * (sans Z et sans TZID). Un planning est une heure murale — un poste a 08:00
 * commence a 08:00 la ou on travaille, quel que soit le fuseau du telephone.
 * Ecrire un instant UTC decalerait tout le planning au premier voyage ou au
 * changement d'heure.
 */
import { addDaysISO, crossesMidnight } from '../lib/datetime';
import { SHIFT_KIND_LABELS } from '../types';
import type { Person, Shift } from '../types';

const PRODID = '-//Smart Planning//FR';
/** Domaine des UID : stable, pour qu'un reimport mette a jour au lieu de dupliquer. */
const UID_DOMAIN = 'smart-planning.local';

/** Echappe les caracteres reserves d'une valeur iCalendar. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Repliement des lignes a 75 OCTETS (et non 75 caracteres) : un accent occupe
 * 2 octets en UTF-8, et certains clients rejettent les lignes trop longues.
 * On ne coupe jamais au milieu d'une sequence multi-octets.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  // Une ligne de continuation commence par une espace, qui consomme 1 octet.
  let limit = 75;

  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    if (currentBytes + charBytes > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
      limit = 74;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0) parts.push(current);

  return parts.join('\r\n ');
}

/** "2026-09-12" -> "20260912" */
const icsDate = (isoDate: string): string => isoDate.replace(/-/g, '');

/** "2026-09-12" + "08:30" -> "20260912T083000" (heure locale flottante) */
const icsDateTime = (isoDate: string, time: string): string =>
  `${icsDate(isoDate)}T${time.replace(':', '')}00`;

function icsTimestamp(date: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

export interface IcsOptions {
  /** Nom du calendrier propose a l'import (Apple et Google le respectent). */
  readonly calendarName: string;
  /** Prefixe les titres du nom de la personne, utile pour un agenda d'equipe. */
  readonly includePersonName: boolean;
  /** Exporte aussi repos et absences, en evenements journee entiere. */
  readonly includeNonWork: boolean;
}

export const DEFAULT_ICS_OPTIONS: IcsOptions = {
  calendarName: 'Planning',
  includePersonName: false,
  includeNonWork: true,
};

function buildEvent(
  shift: Shift,
  person: Person | undefined,
  options: IcsOptions,
  stamp: string,
): string[] {
  const personName = person?.displayName ?? 'Inconnu';
  const kindLabel = SHIFT_KIND_LABELS[shift.kind];
  const summary = options.includePersonName
    ? `${personName} — ${shift.label}`
    : shift.label;

  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${shift.id}@${UID_DOMAIN}`,
    `DTSTAMP:${stamp}`,
  ];

  if (shift.start !== null && shift.end !== null) {
    // Un poste de nuit se termine le lendemain : sans ce decalage, DTEND
    // serait anterieur a DTSTART et le client rejetterait l'evenement.
    const endDate = crossesMidnight(shift.start, shift.end)
      ? addDaysISO(shift.date, 1)
      : shift.date;
    lines.push(
      `DTSTART:${icsDateTime(shift.date, shift.start)}`,
      `DTEND:${icsDateTime(endDate, shift.end)}`,
    );
  } else if (shift.start !== null) {
    // Heure de fin inconnue : duree conventionnelle d'une heure, plutot que
    // de transformer le poste en journee entiere et masquer l'horaire lu.
    lines.push(
      `DTSTART:${icsDateTime(shift.date, shift.start)}`,
      `DURATION:PT1H`,
    );
  } else {
    // Journee entiere : DTEND est EXCLUSIF, donc le lendemain.
    lines.push(
      `DTSTART;VALUE=DATE:${icsDate(shift.date)}`,
      `DTEND;VALUE=DATE:${icsDate(addDaysISO(shift.date, 1))}`,
      'TRANSP:TRANSPARENT',
    );
  }

  const description = [
    `Personne : ${personName}`,
    `Type : ${kindLabel}`,
    shift.note ? `Note : ${shift.note}` : null,
    shift.confidence < 0.6 ? 'Lecture incertaine, a verifier.' : null,
  ]
    .filter((part): part is string => part !== null)
    .join('\n');

  lines.push(
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `CATEGORIES:${escapeText(kindLabel)}`,
    'END:VEVENT',
  );

  return lines;
}

/** Construit le contenu .ics complet pour un ensemble de postes. */
export function buildIcs(
  shifts: readonly Shift[],
  people: readonly Person[],
  options: IcsOptions = DEFAULT_ICS_OPTIONS,
): string {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const stamp = icsTimestamp(new Date());

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.calendarName)}`,
    'X-APPLE-CALENDAR-COLOR:#1a73e8',
  ];

  const exportable = options.includeNonWork
    ? shifts
    : shifts.filter((shift) => shift.kind === 'work');

  for (const shift of exportable) {
    lines.push(...buildEvent(shift, peopleById.get(shift.personId), options, stamp));
  }

  lines.push('END:VCALENDAR');

  // CRLF impose par la RFC ; le saut final evite qu'un client tronque la fin.
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/**
 * Declenche le telechargement du .ics.
 *
 * Sur iOS le fichier s'ouvre directement dans le Calendrier, ce qui permet de
 * choisir l'agenda de destination. On passe par un `Blob` plutot qu'une data
 * URL car Safari plafonne la taille de ces dernieres.
 */
export function downloadIcs(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.ics') ? filename : `${filename}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Liberation differee : Safari lit le blob de facon asynchrone apres le clic.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
