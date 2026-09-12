/**
 * Modele de donnees central de Smart Planning.
 *
 * Deux invariants portent toute l'application :
 *  1. Un `Shift` est identifie de facon DETERMINISTE par (personId, date, start, end).
 *     Re-importer deux fois la meme photo produit donc exactement les memes ids,
 *     ce qui rend la reconciliation idempotente.
 *  2. Une `Person` est identifiee par son nom NORMALISE, jamais par son nom affiche.
 *     "DUPONT Jean", "Jean Dupont" et "J. DUPONT" convergent vers la meme personne.
 */

/** Date civile au format ISO court, sans fuseau horaire : "2026-09-12". */
export type ISODate = string;

/** Heure locale sur 24h : "08:30". Jamais de fuseau : un planning est local par nature. */
export type HHMM = string;

/** Nature d'une case du planning. Determine la couleur et le comportement a l'export. */
export type ShiftKind =
  | 'work'      // poste travaille
  | 'rest'      // repos / jour off
  | 'leave'     // conges payes
  | 'sick'      // arret maladie
  | 'training'  // formation
  | 'unknown';  // l'IA n'a pas su trancher

export const SHIFT_KINDS: readonly ShiftKind[] = [
  'work', 'rest', 'leave', 'sick', 'training', 'unknown',
] as const;

export const SHIFT_KIND_LABELS: Readonly<Record<ShiftKind, string>> = {
  work: 'Travail',
  rest: 'Repos',
  leave: 'Congés',
  sick: 'Maladie',
  training: 'Formation',
  unknown: 'Indéterminé',
};

export interface Person {
  /** Identifiant stable derive du nom normalise. */
  readonly id: string;
  /** Nom tel qu'affiche dans l'interface, dans sa plus jolie graphie rencontree. */
  displayName: string;
  /** Cle de rapprochement : minuscules, sans accent, tokens tries. */
  readonly normalizedName: string;
  /** Couleur HSL stable, derivee de l'id. */
  color: string;
  /** Marque l'utilisateur de l'app, pour le filtre "Mon planning". */
  isMe: boolean;
  /** Toutes les graphies rencontrees, utile pour diagnostiquer un mauvais rapprochement. */
  aliases: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Shift {
  /** Hash deterministe de (personId, date, start, end) : garantit l'idempotence. */
  readonly id: string;
  readonly personId: string;
  readonly date: ISODate;
  /** `null` pour une entree sur la journee entiere (repos, conges...). */
  start: HHMM | null;
  end: HHMM | null;
  /** Libelle brut lu sur le document : "M", "Matin", "8h-16h", "RH"... */
  label: string;
  kind: ShiftKind;
  note: string | null;
  /** Import qui a produit cette ligne. Permet d'annuler un import entier. */
  importId: string;
  /** Confiance de l'extraction, 0..1. Sous 0.6 l'UI signale la case a verifier. */
  confidence: number;
  updatedAt: number;
}

export type SourceKind = 'image' | 'pdf';

export interface ImportRecord {
  readonly id: string;
  createdAt: number;
  sourceName: string;
  sourceKind: SourceKind;
  /** Nombre de pages/images envoyees au modele. */
  pageCount: number;
  model: string;
  /** Fenetre de dates couverte par le document : borne la reconciliation. */
  rangeStart: ISODate;
  rangeEnd: ISODate;
  personIds: string[];
  /** Bilan de la reconciliation, affiche a l'utilisateur apres import. */
  diff: ImportDiff;
  /** Reponse brute du modele, conservee pour pouvoir rejouer sans rappeler l'API. */
  rawResponse: string;
}

/** Bilan lisible de ce qu'un import a change dans la base. */
export interface ImportDiff {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  newPeople: string[];
}

export interface Settings {
  /** Cle API Groq. Ne quitte jamais l'appareil sauf vers api.groq.com. */
  groqApiKey: string;
  model: string;
  /** Proxy optionnel si l'appel direct navigateur est bloque par CORS. */
  proxyUrl: string;
  /** Personne marquee comme "moi", pour le filtre rapide et l'export .ics. */
  myPersonId: string | null;
  /** Premier jour de la semaine : 1 = lundi (defaut FR). */
  weekStartsOn: 0 | 1;
  /** Derniere vue utilisee, restauree au demarrage. */
  lastView: CalendarView;
}

export type CalendarView = 'month' | 'week' | 'day' | 'people';

/**
 * Resultat explicite a la place des exceptions : toute operation faillible
 * (reseau, parsing IA, lecture de fichier) renvoie un `Result` typiquement
 * discriminable, ce qui force l'appelant a traiter l'echec.
 */
export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type AppErrorCode =
  | 'MISSING_API_KEY'
  | 'NETWORK'
  | 'CORS_BLOCKED'
  | 'RATE_LIMITED'
  | 'AUTH'
  | 'MODEL_ERROR'
  /** Le modele demande n'existe plus au catalogue : declenche un repli automatique. */
  | 'MODEL_NOT_FOUND'
  | 'INVALID_RESPONSE'
  | 'EMPTY_EXTRACTION'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE'
  | 'PDF_RENDER'
  | 'STORAGE';

export interface AppError {
  readonly code: AppErrorCode;
  /** Message deja redige en francais, affichable tel quel a l'utilisateur. */
  readonly message: string;
  /** Piste de resolution concrete, affichee sous le message. */
  readonly hint?: string;
  readonly cause?: unknown;
}

export const appError = (
  code: AppErrorCode,
  message: string,
  options: { hint?: string; cause?: unknown } = {},
): AppError => ({ code, message, hint: options.hint, cause: options.cause });
