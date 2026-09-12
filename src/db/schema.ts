/**
 * Schema IndexedDB.
 *
 * IndexedDB est choisi plutot que localStorage parce que le planning est une
 * donnee relationnelle et potentiellement volumineuse (plusieurs annees x
 * plusieurs collegues) : il faut des index pour interroger par date et par
 * personne sans charger toute la base en memoire, et des transactions pour
 * qu'un import soit atomique.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ImportRecord, Person, Settings, Shift } from '../types';

export const DB_NAME = 'smart-planning';
export const DB_VERSION = 1;

/** Cle unique de la ligne de reglages (store mono-enregistrement). */
export const SETTINGS_KEY = 'app';

export interface SmartPlanningDB extends DBSchema {
  people: {
    key: string;
    value: Person;
    indexes: { 'by-normalized': string };
  };
  shifts: {
    key: string;
    value: Shift;
    indexes: {
      'by-date': string;
      'by-person': string;
      'by-import': string;
      /** Index compose : requete "les postes de X entre deux dates" en une passe. */
      'by-person-date': [string, string];
    };
  };
  imports: {
    key: string;
    value: ImportRecord;
    indexes: { 'by-created': number };
  };
  settings: {
    key: string;
    value: Settings & { key: string };
  };
}

export const DEFAULT_SETTINGS: Settings = {
  groqApiKey: '',
  // Modele vision par defaut. Modifiable dans les reglages : Groq fait evoluer
  // son catalogue, et l'app sait lister les modeles disponibles du compte.
  model: 'meta-llama/llama-4-scout-17b-16e-instruct',
  proxyUrl: '',
  myPersonId: null,
  weekStartsOn: 1,
  lastView: 'month',
};

let dbPromise: Promise<IDBPDatabase<SmartPlanningDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<SmartPlanningDB>> {
  dbPromise ??= openDB<SmartPlanningDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Les migrations futures s'ajoutent en cascade sans `break`, chaque palier
      // appliquant uniquement son propre delta.
      if (oldVersion < 1) {
        const people = db.createObjectStore('people', { keyPath: 'id' });
        people.createIndex('by-normalized', 'normalizedName', { unique: false });

        const shifts = db.createObjectStore('shifts', { keyPath: 'id' });
        shifts.createIndex('by-date', 'date');
        shifts.createIndex('by-person', 'personId');
        shifts.createIndex('by-import', 'importId');
        shifts.createIndex('by-person-date', ['personId', 'date']);

        const imports = db.createObjectStore('imports', { keyPath: 'id' });
        imports.createIndex('by-created', 'createdAt');

        db.createObjectStore('settings', { keyPath: 'key' });
      }
    },
    blocked() {
      console.warn('[db] Une autre version de l’application bloque la migration.');
    },
    blocking() {
      // Un autre onglet veut migrer : on libere la connexion pour ne pas le bloquer.
      void dbPromise?.then((db) => db.close());
      dbPromise = null;
    },
  });
  return dbPromise;
}
