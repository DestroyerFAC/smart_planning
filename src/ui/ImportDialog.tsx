/**
 * Import d'un planning : photo, PDF ou fichier depose.
 *
 * L'ecran affiche systematiquement le BILAN de la reconciliation (ajoutes,
 * modifies, supprimes). C'est ce qui rend la mise a jour automatique
 * acceptable : l'utilisateur voit ce que l'app a change dans son planning au
 * lieu de le decouvrir plus tard.
 */
import { useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { Alert, ErrorAlert, Modal } from './components';
import { importPlanningFile, type ImportProgress } from '../ingest/pipeline';
import { isSupportedFile } from '../ingest/files';
import { undoImport } from '../db/repo';
import { parseISODate } from '../lib/datetime';
import { appError } from '../types';
import { usePlanning } from './store';
import type { AppError, ImportRecord } from '../types';

const PHASE_LABELS: Readonly<Record<ImportProgress['phase'], string>> = {
  preparing: 'Préparation de l’image',
  analyzing: 'Lecture du planning par l’IA',
  saving: 'Mise à jour du calendrier',
};

interface Outcome {
  readonly record: ImportRecord;
  readonly warnings: string[];
}

export function ImportDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const { settings, refresh, setAnchor, setView } = usePlanning();
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = progress !== null;

  const handleFile = async (file: File): Promise<void> => {
    if (!isSupportedFile(file)) {
      setError(appError('UNSUPPORTED_FILE', 'Format non pris en charge.', {
        hint: 'Utilise une photo (JPEG, PNG, HEIC) ou un PDF.',
      }));
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setOutcome(null);
    setProgress({ phase: 'preparing', done: 0, total: 1 });

    const result = await importPlanningFile(file, {
      settings,
      onProgress: setProgress,
      signal: controller.signal,
    });

    abortRef.current = null;
    setProgress(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setOutcome(result.value);
    await refresh();
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reinitialise la valeur : sans cela, reselectionner le MEME fichier
    // apres une erreur ne declencherait aucun evenement.
    event.target.value = '';
    if (file) void handleFile(file);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void handleFile(file);
  };

  const handleUndo = async (): Promise<void> => {
    if (outcome === null) return;
    await undoImport(outcome.record.id);
    await refresh();
    setOutcome(null);
  };

  const handleSeeResult = (): void => {
    if (outcome === null) return;
    setAnchor(outcome.record.rangeStart);
    setView('month');
    onClose();
  };

  return (
    <Modal title="Importer un planning" onClose={busy ? () => undefined : onClose}>
      {error !== null && <ErrorAlert error={error} />}

      {outcome !== null ? (
        <ImportSummary outcome={outcome} onUndo={() => void handleUndo()} onSee={handleSeeResult} />
      ) : busy ? (
        <ProgressPanel
          progress={progress}
          onCancel={() => { abortRef.current?.abort(); setProgress(null); }}
        />
      ) : (
        <>
          <div
            className="dropzone"
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            style={dragging ? { borderColor: 'var(--blue)', background: 'var(--blue-soft)' } : undefined}
          >
            <span className="dropzone__icon" aria-hidden="true">&#128247;</span>
            <strong>Photo ou PDF du planning</strong>
            <span className="dropzone__hint">
              Cadre bien le tableau, noms et jours lisibles.
            </span>
          </div>

          <div className="btnrow" style={{ marginTop: 16 }}>
            {/* `capture` ouvre directement l'appareil photo sur mobile ; sur
                ordinateur l'attribut est ignore et le selecteur s'affiche. */}
            <label className="btn btn--primary">
              Prendre une photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={onInputChange}
                className="sr-only"
              />
            </label>
            <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
              Choisir un fichier
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              onChange={onInputChange}
              className="sr-only"
            />
          </div>

          {settings.groqApiKey.trim() === '' && (
            <Alert tone="warn" title="Cl&eacute; API manquante">
              <p className="alert__hint">
                Ouvre R&eacute;glages et colle ta cl&eacute; Groq. Elle est gratuite sur
                console.groq.com/keys et reste sur ton appareil.
              </p>
            </Alert>
          )}
        </>
      )}
    </Modal>
  );
}

function ProgressPanel({
  progress,
  onCancel,
}: {
  readonly progress: ImportProgress | null;
  readonly onCancel: () => void;
}): ReactNode {
  if (progress === null) return null;
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  return (
    <div className="center stack">
      <p>
        <span className="spinner" /> {PHASE_LABELS[progress.phase]}
      </p>
      <div className="progress">
        <div className="progress__bar" style={{ width: `${percent}%` }} />
      </div>
      {progress.total > 1 && (
        <p className="muted small">Page {Math.min(progress.done + 1, progress.total)} sur {progress.total}</p>
      )}
      <p className="muted small">L&rsquo;analyse prend g&eacute;n&eacute;ralement 5 &agrave; 15 secondes.</p>
      <button type="button" className="btn" onClick={onCancel}>Annuler</button>
    </div>
  );
}

function ImportSummary({
  outcome,
  onUndo,
  onSee,
}: {
  readonly outcome: Outcome;
  readonly onUndo: () => void;
  readonly onSee: () => void;
}): ReactNode {
  const { diff, rangeStart, rangeEnd, personIds } = outcome.record;
  const touched = diff.added + diff.updated + diff.removed;

  return (
    <div className="stack">
      <Alert tone="success" title={touched === 0 ? 'Planning déjà à jour' : 'Planning mis à jour'}>
        <p className="alert__hint" style={{ margin: 0 }}>
          {formatRange(rangeStart, rangeEnd)} &middot; {personIds.length} personne
          {personIds.length > 1 ? 's' : ''}
        </p>
      </Alert>

      <ul style={{ margin: 0, paddingLeft: 20 }}>
        <li><strong>{diff.added}</strong> poste{diff.added > 1 ? 's' : ''} ajout&eacute;{diff.added > 1 ? 's' : ''}</li>
        <li><strong>{diff.updated}</strong> modifi&eacute;{diff.updated > 1 ? 's' : ''}</li>
        <li><strong>{diff.removed}</strong> supprim&eacute;{diff.removed > 1 ? 's' : ''}</li>
        <li className="muted">{diff.unchanged} inchang&eacute;{diff.unchanged > 1 ? 's' : ''}</li>
      </ul>

      {diff.newPeople.length > 0 && (
        <p className="small">
          Nouveaux coll&egrave;gues : <strong>{diff.newPeople.join(', ')}</strong>
        </p>
      )}

      {outcome.warnings.length > 0 && (
        <Alert tone="warn" title="&Agrave; v&eacute;rifier">
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {outcome.warnings.slice(0, 6).map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </Alert>
      )}

      <div className="btnrow">
        <button type="button" className="btn btn--primary" onClick={onSee}>Voir le calendrier</button>
        <button type="button" className="btn" onClick={onUndo}>Annuler cet import</button>
      </div>
    </div>
  );
}

function formatRange(start: string, end: string): string {
  const from = parseISODate(start);
  const to = parseISODate(end);
  if (!from || !to) return `${start} → ${end}`;
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return start === end
    ? from.toLocaleDateString('fr-FR', { ...options, year: 'numeric' })
    : `${from.toLocaleDateString('fr-FR', options)} – ${to.toLocaleDateString('fr-FR', { ...options, year: 'numeric' })}`;
}
