/**
 * Reconciliation d'un nouvel import avec les donnees deja en base.
 *
 * C'est le coeur de la promesse "je rephotographie le planning et il se met a
 * jour tout seul". La regle est la suivante :
 *
 *   Pour chaque personne presente sur le NOUVEAU document, et pour chaque date
 *   comprise dans la plage couverte par ce document, l'etat du nouveau document
 *   fait autorite et remplace integralement l'ancien.
 *
 * Deux consequences voulues :
 *  - Un horaire modifie sur le planning affiche est modifie dans l'app.
 *  - Un poste supprime du planning affiche disparait de l'app (il ne survit pas
 *    en fantome), parce qu'on nettoie toute la fenetre avant de reecrire.
 *
 * Et deux protections :
 *  - Un collegue ABSENT du nouveau document n'est jamais touche : on ne
 *    supprime que dans le perimetre des personnes reellement lues.
 *  - Hors de la plage de dates du document, rien n'est touche non plus.
 *
 * Ces fonctions sont PURES : elles calculent un plan, elles n'ecrivent rien.
 * L'ecriture transactionnelle est faite par `commitImportPlan` dans repo.ts.
 */
import { buildPerson, shiftId } from '../db/repo';
import { findMatchingPerson, prettiestName } from './names';
import { datesBetween } from '../lib/datetime';
import type { CleanExtraction } from '../ai/schema';
import type { ImportDiff, ImportRecord, Person, Shift, SourceKind } from '../types';

export interface PersonResolution {
  /** Nom lu sur le document -> personne en base (existante ou nouvellement creee). */
  readonly mapping: ReadonlyMap<string, Person>;
  /** Fiches a ecrire : nouvelles personnes + fiches existantes enrichies d'un alias. */
  readonly toUpsert: Person[];
  /** Noms affichables des personnes decouvertes, pour le bilan d'import. */
  readonly createdNames: string[];
}

/**
 * Associe chaque nom lu a une personne en base, en creant les manquantes.
 *
 * Les personnes creees pendant CET import sont ajoutees au pool de recherche au
 * fur et a mesure : si le document ecrit "J. Martin" en en-tete et "Martin Jean"
 * plus bas, les deux convergent vers la meme fiche au lieu d'en creer deux.
 */
export function resolvePeople(
  extraction: CleanExtraction,
  existingPeople: readonly Person[],
): PersonResolution {
  const pool: Person[] = [...existingPeople];
  const mapping = new Map<string, Person>();
  const toUpsert = new Map<string, Person>();
  const createdNames: string[] = [];

  for (const extracted of extraction.people) {
    const match = findMatchingPerson(extracted.name, pool);

    if (match) {
      const person = match.person;
      const alreadyKnown = person.aliases.some(
        (alias) => alias.toLowerCase() === extracted.name.toLowerCase(),
      );

      if (alreadyKnown) {
        mapping.set(extracted.name, person);
        continue;
      }

      // Nouvelle graphie du meme nom : on l'enregistre et on en profite pour
      // afficher la plus lisible des deux.
      const aliases = [...person.aliases, extracted.name];
      const enriched: Person = {
        ...person,
        aliases,
        displayName: prettiestName(aliases),
        updatedAt: Date.now(),
      };
      mapping.set(extracted.name, enriched);
      toUpsert.set(enriched.id, enriched);

      const index = pool.findIndex((p) => p.id === enriched.id);
      if (index >= 0) pool[index] = enriched;
      continue;
    }

    const created = buildPerson(extracted.name);
    // Un id deja present signifie que deux graphies se normalisent pareil :
    // c'est la meme personne, on reutilise la fiche plutot que d'ecraser.
    const existing = toUpsert.get(created.id);
    if (existing) {
      mapping.set(extracted.name, existing);
      continue;
    }

    mapping.set(extracted.name, created);
    toUpsert.set(created.id, created);
    pool.push(created);
    createdNames.push(created.displayName);
  }

  return { mapping, toUpsert: [...toUpsert.values()], createdNames };
}

export interface ImportPlan {
  readonly importId: string;
  readonly peopleToUpsert: readonly Person[];
  readonly shiftsToPut: readonly Shift[];
  readonly shiftIdsToDelete: readonly string[];
  readonly record: ImportRecord;
}

export interface ImportMeta {
  readonly sourceName: string;
  readonly sourceKind: SourceKind;
  readonly pageCount: number;
  readonly model: string;
  readonly rawResponse: string;
}

/** Identifiant d'import, avec repli si crypto.randomUUID est indisponible. */
function newImportId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `i_${uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;
}

/**
 * Construit le plan d'ecriture complet.
 *
 * @param existingShifts Postes deja en base couvrant AU MOINS la plage du
 *        document. Fournir moins que la plage ferait manquer des suppressions.
 */
export function buildImportPlan(
  extraction: CleanExtraction,
  resolution: PersonResolution,
  existingShifts: readonly Shift[],
  meta: ImportMeta,
): ImportPlan {
  const importId = newImportId();
  const now = Date.now();

  const touchedPersonIds = new Set(
    [...resolution.mapping.values()].map((person) => person.id),
  );
  const coveredDates = new Set(datesBetween(extraction.rangeStart, extraction.rangeEnd));

  // 1. Materialiser les postes du nouveau document.
  const nextShifts = new Map<string, Shift>();
  for (const extracted of extraction.people) {
    const person = resolution.mapping.get(extracted.name);
    if (!person) continue;

    for (const entry of extracted.entries) {
      const id = shiftId(person.id, entry.date, entry.start, entry.end);
      // Deux lignes identiques sur le document : on garde la plus sure.
      const previous = nextShifts.get(id);
      if (previous && previous.confidence >= entry.confidence) continue;

      nextShifts.set(id, {
        id,
        personId: person.id,
        date: entry.date,
        start: entry.start,
        end: entry.end,
        label: entry.label,
        kind: entry.kind,
        note: entry.note,
        importId,
        confidence: entry.confidence,
        updatedAt: now,
      });

      // Une entree peut tomber hors de la plage annoncee (ligne de report en
      // marge du tableau) : on etend la fenetre pour rester coherent.
      coveredDates.add(entry.date);
    }
  }

  // 2. Confronter a l'existant, dans le seul perimetre concerne.
  const inScope = existingShifts.filter(
    (shift) => touchedPersonIds.has(shift.personId) && coveredDates.has(shift.date),
  );

  const shiftIdsToDelete: string[] = [];
  let updated = 0;
  let unchanged = 0;
  let added = 0;
  let removed = 0;

  // On raisonne par CASE du tableau, c'est-a-dire par couple (personne, jour).
  //
  // L'identifiant d'un poste encode ses horaires : un poste dont l'heure change
  // recoit donc un identifiant different. Compare identifiant par identifiant,
  // un simple decalage d'horaire ressemblerait a une suppression suivie d'un
  // ajout — exact du point de vue de la base, mais trompeur pour quelqu'un qui
  // a juste vu un horaire bouger sur le planning affiche. Le regroupement par
  // case permet d'apparier l'ancien et le nouveau et d'annoncer "modifie".
  const oldByCell = groupByCell(inScope);
  const newByCell = groupByCell([...nextShifts.values()]);

  for (const key of new Set([...oldByCell.keys(), ...newByCell.keys()])) {
    const olds = oldByCell.get(key) ?? [];
    const news = newByCell.get(key) ?? [];

    const orphanedOld: Shift[] = [];
    for (const existing of olds) {
      const replacement = nextShifts.get(existing.id);
      if (!replacement) {
        orphanedOld.push(existing);
        continue;
      }
      if (isSameContent(existing, replacement)) {
        unchanged += 1;
        // Ligne identique : inutile de la reecrire, mais on la rattache au
        // dernier import pour que son annulation reste coherente.
        nextShifts.set(existing.id, { ...existing, importId, updatedAt: now });
      } else {
        updated += 1;
      }
    }

    const oldIds = new Set(olds.map((shift) => shift.id));
    const orphanedNew = news.filter((shift) => !oldIds.has(shift.id));

    // Dans une meme case, un ancien orphelin face a un nouveau orphelin est
    // un horaire modifie. Le reste est un vrai ajout ou une vraie suppression.
    const moved = Math.min(orphanedOld.length, orphanedNew.length);
    updated += moved;
    removed += orphanedOld.length - moved;
    added += orphanedNew.length - moved;

    // Les orphelins anciens disparaissent dans tous les cas : soit remplaces
    // par le nouvel identifiant, soit reellement supprimes du planning.
    for (const existing of orphanedOld) shiftIdsToDelete.push(existing.id);
  }

  const diff: ImportDiff = {
    added,
    updated,
    removed,
    unchanged,
    newPeople: resolution.createdNames,
  };

  const sortedDates = [...coveredDates].sort();

  const record: ImportRecord = {
    id: importId,
    createdAt: now,
    sourceName: meta.sourceName,
    sourceKind: meta.sourceKind,
    pageCount: meta.pageCount,
    model: meta.model,
    rangeStart: sortedDates[0] ?? extraction.rangeStart,
    rangeEnd: sortedDates[sortedDates.length - 1] ?? extraction.rangeEnd,
    personIds: [...touchedPersonIds],
    diff,
    rawResponse: meta.rawResponse,
  };

  return {
    importId,
    peopleToUpsert: resolution.toUpsert,
    shiftsToPut: [...nextShifts.values()],
    shiftIdsToDelete,
    record,
  };
}

/**
 * Indexe des postes par case du tableau, c'est-a-dire par (personne, jour).
 * Le separateur ne peut apparaitre dans aucun des deux champs : un identifiant
 * de personne est de la forme `p_<base36>` et une date est au format ISO.
 */
function groupByCell(shifts: readonly Shift[]): Map<string, Shift[]> {
  const grouped = new Map<string, Shift[]>();
  for (const shift of shifts) {
    const key = `${shift.personId}|${shift.date}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(shift);
    else grouped.set(key, [shift]);
  }
  return grouped;
}

/**
 * Compare le contenu metier de deux postes.
 * `id`, `importId`, `updatedAt` et `confidence` sont exclus : ils changent a
 * chaque import sans que le planning affiche soit different.
 */
function isSameContent(a: Shift, b: Shift): boolean {
  return a.label === b.label && a.kind === b.kind && a.note === b.note;
}
