/**
 * Acces aux donnees. Seule couche autorisee a parler a IndexedDB : l'UI et le
 * pipeline d'import passent exclusivement par ces fonctions, ce qui garde les
 * transactions et les invariants au meme endroit.
 */
import { DEFAULT_SETTINGS, getDB, SETTINGS_KEY } from './schema';
import { colorForPerson, normalizeName, personIdFromName, prettiestName } from '../ingest/names';
import { hashFields } from '../lib/hash';
import { Err, Ok, appError } from '../types';
import type { ImportRecord, ISODate, Person, Result, Settings, Shift } from '../types';
import type { ImportPlan } from '../ingest/reconcile';

/* ------------------------------------------------------------------ People */

export async function listPeople(): Promise<Person[]> {
  const db = await getDB();
  const people = await db.getAll('people');
  return people.sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
}

export async function getPerson(id: string): Promise<Person | undefined> {
  const db = await getDB();
  return db.get('people', id);
}

/** Cree une fiche personne a partir d'un nom brut, sans l'ecrire en base. */
export function buildPerson(rawName: string): Person {
  const now = Date.now();
  const id = personIdFromName(rawName);
  return {
    id,
    displayName: prettiestName([rawName]),
    normalizedName: normalizeName(rawName),
    color: colorForPerson(id),
    isMe: false,
    aliases: [rawName.trim()],
    createdAt: now,
    updatedAt: now,
  };
}

export async function upsertPerson(person: Person): Promise<void> {
  const db = await getDB();
  await db.put('people', { ...person, updatedAt: Date.now() });
}

export async function renamePerson(id: string, displayName: string): Promise<Result<Person>> {
  const db = await getDB();
  const person = await db.get('people', id);
  if (!person) return Err(appError('STORAGE', 'Cette personne n’existe plus.'));

  const updated: Person = {
    ...person,
    displayName: displayName.trim() || person.displayName,
    updatedAt: Date.now(),
  };
  await db.put('people', updated);
  return Ok(updated);
}

/** Designe la personne correspondant a l'utilisateur ; une seule a la fois. */
export async function setMyPerson(id: string | null): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['people', 'settings'], 'readwrite');
  const store = tx.objectStore('people');

  for (const person of await store.getAll()) {
    const shouldBeMe = person.id === id;
    if (person.isMe !== shouldBeMe) {
      await store.put({ ...person, isMe: shouldBeMe, updatedAt: Date.now() });
    }
  }

  const settingsStore = tx.objectStore('settings');
  const current = (await settingsStore.get(SETTINGS_KEY)) ?? { ...DEFAULT_SETTINGS, key: SETTINGS_KEY };
  await settingsStore.put({ ...current, myPersonId: id });
  await tx.done;
}

/**
 * Fusionne `sourceId` dans `targetId` : rattache tous les postes, additionne
 * les alias, supprime la fiche source. Utilise quand le rapprochement
 * automatique a ete trop prudent et a cree un doublon.
 */
export async function mergePeople(sourceId: string, targetId: string): Promise<Result<void>> {
  if (sourceId === targetId) return Ok(undefined);

  const db = await getDB();
  const tx = db.transaction(['people', 'shifts'], 'readwrite');
  const peopleStore = tx.objectStore('people');
  const shiftsStore = tx.objectStore('shifts');

  const [source, target] = await Promise.all([peopleStore.get(sourceId), peopleStore.get(targetId)]);
  if (!source || !target) {
    tx.abort();
    return Err(appError('STORAGE', 'Impossible de fusionner : une des deux fiches est introuvable.'));
  }

  const moved = await shiftsStore.index('by-person').getAll(sourceId);
  for (const shift of moved) {
    await shiftsStore.delete(shift.id);
    // L'id encode le personId : il faut le recalculer, pas juste reaffecter le champ.
    const reassigned: Shift = { ...shift, personId: targetId, id: shiftId(targetId, shift.date, shift.start, shift.end) };
    // `put` et non `add` : si la cible avait deja ce creneau, le doublon disparait.
    await shiftsStore.put(reassigned);
  }

  await peopleStore.put({
    ...target,
    aliases: [...new Set([...target.aliases, ...source.aliases])],
    isMe: target.isMe || source.isMe,
    updatedAt: Date.now(),
  });
  await peopleStore.delete(sourceId);
  await tx.done;
  return Ok(undefined);
}

export async function deletePerson(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['people', 'shifts'], 'readwrite');
  const shiftsStore = tx.objectStore('shifts');
  for (const shift of await shiftsStore.index('by-person').getAll(id)) {
    await shiftsStore.delete(shift.id);
  }
  await tx.objectStore('people').delete(id);
  await tx.done;
}

/* ------------------------------------------------------------------ Shifts */


/**
 * Identifiant deterministe d'un poste.
 * Deux imports successifs du meme planning produisent les memes ids, donc
 * `put` ecrase au lieu de dupliquer : la reconciliation devient idempotente.
 */
export function shiftId(
  personId: string,
  date: ISODate,
  start: string | null,
  end: string | null,
): string {
  return `s_${hashFields(personId, date, start, end)}`;
}

export async function getShiftsBetween(start: ISODate, end: ISODate): Promise<Shift[]> {
  const db = await getDB();
  return db.getAllFromIndex('shifts', 'by-date', IDBKeyRange.bound(start, end));
}

export async function getShiftsForPerson(personId: string): Promise<Shift[]> {
  const db = await getDB();
  return db.getAllFromIndex('shifts', 'by-person', personId);
}

export async function putShift(shift: Shift): Promise<void> {
  const db = await getDB();
  await db.put('shifts', { ...shift, updatedAt: Date.now() });
}

export async function deleteShift(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('shifts', id);
}

export async function countShifts(): Promise<number> {
  const db = await getDB();
  return db.count('shifts');
}

/* ----------------------------------------------------------------- Imports */

export async function listImports(): Promise<ImportRecord[]> {
  const db = await getDB();
  const records = await db.getAllFromIndex('imports', 'by-created');
  return records.reverse();
}

export async function getImport(id: string): Promise<ImportRecord | undefined> {
  const db = await getDB();
  return db.get('imports', id);
}

/**
 * Annule un import : supprime les postes qu'il a crees.
 *
 * Limite assumee et signalee dans l'UI : les postes qu'il a ECRASES ne sont pas
 * restaures, car on ne conserve pas l'etat anterieur ligne par ligne. Reimporter
 * le document precedent les retablit.
 */
export async function undoImport(importId: string): Promise<Result<number>> {
  const db = await getDB();
  const tx = db.transaction(['shifts', 'imports'], 'readwrite');
  const shiftsStore = tx.objectStore('shifts');
  const affected = await shiftsStore.index('by-import').getAll(importId);
  for (const shift of affected) await shiftsStore.delete(shift.id);
  await tx.objectStore('imports').delete(importId);
  await tx.done;
  return Ok(affected.length);
}

/* ---------------------------------------------------------------- Settings */

export async function loadSettings(): Promise<Settings> {
  const db = await getDB();
  const stored = await db.get('settings', SETTINGS_KEY);
  // Fusion avec les valeurs par defaut : une version future peut ajouter un
  // champ sans casser les bases existantes.
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = await getDB();
  const tx = db.transaction('settings', 'readwrite');
  const store = tx.objectStore('settings');
  const current = (await store.get(SETTINGS_KEY)) ?? { ...DEFAULT_SETTINGS, key: SETTINGS_KEY };
  const merged = { ...current, ...patch, key: SETTINGS_KEY };
  await store.put(merged);
  await tx.done;
  const { key: _key, ...settings } = merged;
  return settings;
}

/* ------------------------------------------------------------ Sauvegardes */

export interface BackupPayload {
  readonly format: 'smart-planning-backup';
  readonly version: number;
  readonly exportedAt: string;
  readonly people: Person[];
  readonly shifts: Shift[];
  readonly imports: ImportRecord[];
}

/** Export complet, cle API volontairement exclue. */
export async function exportBackup(): Promise<BackupPayload> {
  const db = await getDB();
  const [people, shifts, imports] = await Promise.all([
    db.getAll('people'),
    db.getAll('shifts'),
    db.getAll('imports'),
  ]);
  return {
    format: 'smart-planning-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    people,
    shifts,
    // La reponse brute du modele peut peser lourd et n'a pas d'interet hors ligne.
    imports: imports.map((record) => ({ ...record, rawResponse: '' })),
  };
}

export async function importBackup(payload: unknown): Promise<Result<number>> {
  if (!isBackupPayload(payload)) {
    return Err(appError('INVALID_RESPONSE', 'Ce fichier n’est pas une sauvegarde Smart Planning.'));
  }

  const db = await getDB();
  const tx = db.transaction(['people', 'shifts', 'imports'], 'readwrite');
  for (const person of payload.people) await tx.objectStore('people').put(person);
  for (const shift of payload.shifts) await tx.objectStore('shifts').put(shift);
  for (const record of payload.imports) await tx.objectStore('imports').put(record);
  await tx.done;
  return Ok(payload.shifts.length);
}

function isBackupPayload(value: unknown): value is BackupPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BackupPayload>;
  return (
    candidate.format === 'smart-planning-backup' &&
    Array.isArray(candidate.people) &&
    Array.isArray(candidate.shifts) &&
    Array.isArray(candidate.imports)
  );
}

/** Efface toutes les donnees metier. Les reglages (dont la cle API) survivent. */
export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['people', 'shifts', 'imports'], 'readwrite');
  await Promise.all([
    tx.objectStore('people').clear(),
    tx.objectStore('shifts').clear(),
    tx.objectStore('imports').clear(),
  ]);
  await tx.done;
}

/* --------------------------------------------------- Commit d'un import */

/**
 * Applique un plan d'import dans UNE transaction.
 *
 * L'atomicite n'est pas un luxe ici : un plan supprime des postes avant d'en
 * reecrire. Une interruption entre les deux (onglet ferme, quota disque)
 * laisserait le planning ampute. IndexedDB annule alors tout le lot.
 */
export async function commitImportPlan(plan: ImportPlan): Promise<Result<ImportRecord>> {
  try {
    const db = await getDB();
    const tx = db.transaction(['people', 'shifts', 'imports'], 'readwrite');
    const peopleStore = tx.objectStore('people');
    const shiftsStore = tx.objectStore('shifts');

    for (const person of plan.peopleToUpsert) await peopleStore.put(person);
    // Suppressions d'abord : un poste deplace peut liberer un id que la
    // reecriture va reutiliser.
    for (const id of plan.shiftIdsToDelete) await shiftsStore.delete(id);
    for (const shift of plan.shiftsToPut) await shiftsStore.put(shift);

    await tx.objectStore('imports').put(plan.record);
    await tx.done;
    return Ok(plan.record);
  } catch (cause) {
    return Err(appError('STORAGE', 'Enregistrement du planning impossible.', {
      hint: 'La mémoire du navigateur est peut-être pleine. Libère de l’espace puis réessaie.',
      cause,
    }));
  }
}
