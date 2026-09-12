/**
 * Orchestration d'un import de bout en bout :
 * fichier -> images -> extraction IA -> reconciliation -> ecriture.
 *
 * Chaque etape renvoie un `Result`. Le pipeline s'arrete a la premiere erreur
 * bloquante, mais tolere l'echec d'une page isolee d'un PDF multi-pages : mieux
 * vaut importer 3 pages sur 4 avec un avertissement que de tout perdre.
 */
import { extractFromImage } from '../ai/groq';
import { mergeExtractions } from '../ai/schema';
import { prepareFile } from './files';
import { buildImportPlan, resolvePeople } from './reconcile';
import { commitImportPlan, getShiftsBetween, listPeople, saveSettings } from '../db/repo';
import { todayISO } from '../lib/datetime';
import { Err, Ok, appError } from '../types';
import type { CleanExtraction } from '../ai/schema';
import type { ImportRecord, Result, Settings } from '../types';

export type ImportPhase = 'preparing' | 'analyzing' | 'saving';

export interface ImportProgress {
  readonly phase: ImportPhase;
  readonly done: number;
  readonly total: number;
}

export interface ImportOutcome {
  readonly record: ImportRecord;
  /** Anomalies non bloquantes, a montrer a l'utilisateur apres coup. */
  readonly warnings: string[];
}

export interface ImportOptions {
  readonly settings: Settings;
  readonly onProgress?: (progress: ImportProgress) => void;
  readonly signal?: AbortSignal;
}

export async function importPlanningFile(
  file: File,
  options: ImportOptions,
): Promise<Result<ImportOutcome>> {
  const { settings, onProgress, signal } = options;

  if (settings.groqApiKey.trim().length === 0) {
    return Err(appError('MISSING_API_KEY', 'Aucune clé API Groq enregistrée.', {
      hint: 'Ouvre Réglages et colle ta clé Groq (gratuite sur console.groq.com/keys).',
    }));
  }

  // 1. Fichier -> images JPEG normalisees.
  const prepared = await prepareFile(file, (done, total) =>
    onProgress?.({ phase: 'preparing', done, total }));
  if (!prepared.ok) return prepared;

  const { images, kind, name, skippedPages } = prepared.value;
  if (images.length === 0) {
    return Err(appError('UNSUPPORTED_FILE', 'Aucune image exploitable dans ce fichier.'));
  }

  const warnings: string[] = [];
  if (skippedPages > 0) {
    warnings.push(`${skippedPages} page(s) ignorée(s) : seules les 8 premières sont analysées.`);
  }

  // 2. Les noms deja connus aident le modele a reprendre la meme graphie,
  //    ce qui evite en amont bien des rapprochements approximatifs.
  const existingPeople = await listPeople();
  const knownNames = existingPeople.map((person) => person.displayName);

  // 3. Une requete par image : plus fiable qu'un envoi groupe (limites de
  //    taille cote API) et permet d'afficher une progression honnete.
  const parts: CleanExtraction[] = [];
  const today = todayISO();

  // Le modele peut changer en cours de route : si celui enregistre a disparu
  // du catalogue Groq, `extractFromImage` bascule seul sur un remplacant. On
  // le retient pour que les pages suivantes l'utilisent directement, au lieu
  // de refaire la decouverte — et l'echec — a chaque page.
  let activeModel = settings.model;

  for (const [index, image] of images.entries()) {
    if (signal?.aborted) return Err(appError('NETWORK', 'Analyse annulée.'));
    onProgress?.({ phase: 'analyzing', done: index, total: images.length });

    const extracted = await extractFromImage(
      image,
      { todayISO: today, pageNumber: index + 1, pageCount: images.length, knownNames },
      {
        apiKey: settings.groqApiKey,
        model: activeModel,
        proxyUrl: settings.proxyUrl,
        ...(signal ? { signal } : {}),
      },
    );

    if (extracted.ok) {
      parts.push(extracted.value.extraction);
      activeModel = extracted.value.modelUsed;
      continue;
    }

    // Sur un document mono-page, l'echec est total : on remonte l'erreur telle
    // quelle pour que l'utilisateur voie la vraie cause.
    if (images.length === 1) return Err(extracted.error);
    warnings.push(`Page ${index + 1} non analysée : ${extracted.error.message}`);
  }

  onProgress?.({ phase: 'analyzing', done: images.length, total: images.length });

  // Repli de modele effectif : on l'enregistre pour que les imports suivants
  // partent directement du bon, et on le dit plutot que de changer un reglage
  // dans le dos de l'utilisateur.
  if (activeModel !== settings.model) {
    await saveSettings({ model: activeModel });
    warnings.push(
      `Le modèle « ${settings.model} » n’est plus disponible ; « ${activeModel} » l’a remplacé.`,
    );
  }

  if (parts.length === 0) {
    return Err(appError('EMPTY_EXTRACTION', 'Aucune page n’a pu être analysée.'));
  }

  const extraction = mergeExtractions(parts);
  warnings.push(...extraction.warnings);

  if (extraction.people.length === 0) {
    return Err(appError('EMPTY_EXTRACTION', 'Aucun planning reconnu sur ce document.', {
      hint: 'Cadre bien le tableau, évite les reflets, et vérifie que les noms sont lisibles.',
    }));
  }

  // 4. Reconciliation.
  onProgress?.({ phase: 'saving', done: 0, total: 1 });

  const resolution = resolvePeople(extraction, existingPeople);

  // La fenetre chargee doit couvrir la plage annoncee ET toute entree qui en
  // deborde, sinon des suppressions seraient manquees.
  const window = coveredWindow(extraction);
  const existingShifts = await getShiftsBetween(window.start, window.end);

  const plan = buildImportPlan(extraction, resolution, existingShifts, {
    sourceName: name,
    sourceKind: kind,
    pageCount: images.length,
    model: activeModel,
    rawResponse: JSON.stringify(extraction),
  });

  const committed = await commitImportPlan(plan);
  if (!committed.ok) return committed;

  onProgress?.({ phase: 'saving', done: 1, total: 1 });
  return Ok({ record: committed.value, warnings });
}

/** Plage reellement concernee : bornes annoncees elargies aux dates presentes. */
function coveredWindow(extraction: CleanExtraction): { start: string; end: string } {
  const dates: string[] = [];
  if (extraction.rangeStart !== '') dates.push(extraction.rangeStart);
  if (extraction.rangeEnd !== '') dates.push(extraction.rangeEnd);
  for (const person of extraction.people) {
    for (const entry of person.entries) dates.push(entry.date);
  }
  dates.sort();
  return {
    start: dates[0] ?? extraction.rangeStart,
    end: dates[dates.length - 1] ?? extraction.rangeEnd,
  };
}
