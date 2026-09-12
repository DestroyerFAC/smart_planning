/**
 * Validation de la reponse du modele.
 *
 * La sortie d'un LLM est une donnee NON FIABLE : meme en mode JSON force, le
 * modele peut inventer un champ, renvoyer "8h30" la ou on attend "08:30", ou
 * halluciner une date impossible. Rien de ce qui sort d'ici n'entre en base
 * sans etre passe par ce schema puis par `normalizeExtraction`.
 */
import { z } from 'zod';
import { isValidISODate, normalizeTime } from '../lib/datetime';
import { SHIFT_KINDS } from '../types';
import type { ShiftKind } from '../types';

/** Accepte ce que le modele produit reellement, on normalise juste apres. */
const looseTime = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => (value === null || value === undefined ? null : normalizeTime(String(value))));

const looseKind = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value): ShiftKind => {
    const candidate = (value ?? 'unknown').toLowerCase().trim();
    return (SHIFT_KINDS as readonly string[]).includes(candidate) ? (candidate as ShiftKind) : 'unknown';
  });

const looseConfidence = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return 0.8;
    // Certains modeles renvoient 95 au lieu de 0.95.
    const scaled = parsed > 1 ? parsed / 100 : parsed;
    return Math.min(1, Math.max(0, scaled));
  });

const entrySchema = z.object({
  date: z.string(),
  start: looseTime,
  end: looseTime,
  label: z.string().optional().default(''),
  kind: looseKind,
  note: z.string().nullish().transform((v) => v ?? null),
  confidence: looseConfidence,
});

const personSchema = z.object({
  name: z.string(),
  entries: z.array(entrySchema).default([]),
});

export const extractionSchema = z.object({
  rangeStart: z.string().nullish().transform((v) => v ?? null),
  rangeEnd: z.string().nullish().transform((v) => v ?? null),
  people: z.array(personSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export type RawExtraction = z.infer<typeof extractionSchema>;

/** Une entree validee, prete a devenir un `Shift`. */
export interface CleanEntry {
  readonly date: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly label: string;
  readonly kind: ShiftKind;
  readonly note: string | null;
  readonly confidence: number;
}

export interface CleanPerson {
  readonly name: string;
  readonly entries: CleanEntry[];
}

export interface CleanExtraction {
  readonly people: CleanPerson[];
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly warnings: string[];
}

/**
 * Deuxieme filtre, metier celui-la : jette tout ce qui ne peut pas exister
 * dans un planning, et recalcule la plage de dates a partir des entrees
 * REELLEMENT retenues plutot que de faire confiance au modele.
 */
export function normalizeExtraction(raw: RawExtraction): CleanExtraction {
  const warnings = [...raw.warnings];
  const people: CleanPerson[] = [];
  const allDates: string[] = [];

  for (const person of raw.people) {
    const name = person.name.trim();
    if (name.length === 0) continue;

    const entries: CleanEntry[] = [];
    for (const entry of person.entries) {
      const date = entry.date.trim();
      if (!isValidISODate(date)) {
        warnings.push(`Date ignoree pour ${name} : "${entry.date}"`);
        continue;
      }

      // Une heure de fin sans heure de debut n'a pas de sens : on retombe sur
      // une entree "journee entiere" plutot que d'inventer un debut.
      const hasStart = entry.start !== null;
      const start = hasStart ? entry.start : null;
      const end = hasStart ? entry.end : null;

      const label = entry.label.trim();
      if (start === null && label.length === 0 && entry.kind === 'unknown') {
        // Case vide du tableau : aucune information, on ne cree rien.
        continue;
      }

      entries.push({
        date,
        start,
        end,
        label: label.length > 0 ? label : defaultLabel(entry.kind, start, end),
        kind: entry.kind === 'unknown' && start !== null ? 'work' : entry.kind,
        note: entry.note,
        confidence: entry.confidence,
      });
      allDates.push(date);
    }

    if (entries.length > 0) people.push({ name, entries });
  }

  allDates.sort();
  const firstDate = allDates[0] ?? '';
  const lastDate = allDates[allDates.length - 1] ?? '';

  // La plage annoncee par le modele n'est retenue que si elle est coherente ;
  // sinon c'est celle deduite des entrees qui fait foi, car la reconciliation
  // supprime tout ce qui tombe dedans.
  const rangeStart = pickRange(raw.rangeStart, firstDate, (a, b) => (a < b ? a : b));
  const rangeEnd = pickRange(raw.rangeEnd, lastDate, (a, b) => (a > b ? a : b));

  return { people, rangeStart, rangeEnd, warnings };
}

function pickRange(
  claimed: string | null,
  derived: string,
  choose: (a: string, b: string) => string,
): string {
  if (derived === '') return claimed && isValidISODate(claimed) ? claimed : '';
  if (!claimed || !isValidISODate(claimed)) return derived;
  return choose(claimed, derived);
}

function defaultLabel(kind: ShiftKind, start: string | null, end: string | null): string {
  if (start && end) return `${start} - ${end}`;
  if (start) return start;
  switch (kind) {
    case 'rest': return 'Repos';
    case 'leave': return 'Congés';
    case 'sick': return 'Maladie';
    case 'training': return 'Formation';
    default: return 'Poste';
  }
}

/** Fusionne les extractions de plusieurs pages d'un meme document. */
export function mergeExtractions(parts: readonly CleanExtraction[]): CleanExtraction {
  const byName = new Map<string, CleanEntry[]>();
  const warnings: string[] = [];
  let rangeStart = '';
  let rangeEnd = '';

  for (const part of parts) {
    warnings.push(...part.warnings);
    if (part.rangeStart !== '' && (rangeStart === '' || part.rangeStart < rangeStart)) {
      rangeStart = part.rangeStart;
    }
    if (part.rangeEnd !== '' && (rangeEnd === '' || part.rangeEnd > rangeEnd)) {
      rangeEnd = part.rangeEnd;
    }
    for (const person of part.people) {
      const existing = byName.get(person.name);
      if (existing) existing.push(...person.entries);
      else byName.set(person.name, [...person.entries]);
    }
  }

  const people: CleanPerson[] = [];
  for (const [name, entries] of byName) {
    // Deduplique les creneaux identiques repetes sur deux pages qui se chevauchent.
    const seen = new Set<string>();
    const unique = entries.filter((entry) => {
      const key = `${entry.date}|${entry.start}|${entry.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    people.push({ name, entries: unique });
  }

  return { people, rangeStart, rangeEnd, warnings };
}
