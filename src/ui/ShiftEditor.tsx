/**
 * Creation et correction manuelle d'un poste.
 *
 * Indispensable meme avec une bonne extraction : un planning affiche est
 * parfois corrige a la main au stylo, et l'IA se trompe sur les cases mal
 * imprimees. L'utilisateur doit toujours pouvoir reprendre la main.
 */
import { useState, type ReactNode } from 'react';
import { Modal, Alert } from './components';
import { deleteShift, putShift, shiftId } from '../db/repo';
import { isValidHHMM, normalizeTime, parseISODate } from '../lib/datetime';
import { SHIFT_KINDS, SHIFT_KIND_LABELS } from '../types';
import { usePlanning } from './store';
import type { ISODate, Shift, ShiftKind } from '../types';

interface ShiftEditorProps {
  readonly date: ISODate;
  /** `null` pour une creation. */
  readonly shift: Shift | null;
  readonly onClose: () => void;
}

export function ShiftEditor({ date, shift, onClose }: ShiftEditorProps): ReactNode {
  const { people, refresh } = usePlanning();

  const [personId, setPersonId] = useState(shift?.personId ?? people[0]?.id ?? '');
  const [start, setStart] = useState(shift?.start ?? '');
  const [end, setEnd] = useState(shift?.end ?? '');
  const [label, setLabel] = useState(shift?.label ?? '');
  const [kind, setKind] = useState<ShiftKind>(shift?.kind ?? 'work');
  const [note, setNote] = useState(shift?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readableDate = parseISODate(date)?.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }) ?? date;

  const handleSave = async (): Promise<void> => {
    if (personId === '') {
      setError('Choisis une personne.');
      return;
    }

    // Les heures sont normalisees avant validation : l'utilisateur peut taper
    // "8h30" aussi bien que "08:30".
    const cleanStart = normalizeTime(start);
    const cleanEnd = normalizeTime(end);

    if (start.trim() !== '' && cleanStart === null) {
      setError(`Heure de début incomprise : "${start}".`);
      return;
    }
    if (end.trim() !== '' && cleanEnd === null) {
      setError(`Heure de fin incomprise : "${end}".`);
      return;
    }
    if (cleanStart === null && cleanEnd !== null) {
      setError('Renseigne une heure de début, ou laisse les deux vides.');
      return;
    }
    if (cleanStart !== null && !isValidHHMM(cleanStart)) {
      setError('Heure de début invalide.');
      return;
    }

    const finalLabel = label.trim() !== ''
      ? label.trim()
      : cleanStart !== null && cleanEnd !== null
        ? `${cleanStart} - ${cleanEnd}`
        : SHIFT_KIND_LABELS[kind];

    setBusy(true);
    setError(null);
    try {
      // L'identifiant encode (personne, date, horaires). Si l'un d'eux change,
      // l'ancienne ligne doit etre supprimee, sinon elle subsisterait en double.
      const nextId = shiftId(personId, date, cleanStart, cleanEnd);
      if (shift !== null && shift.id !== nextId) await deleteShift(shift.id);

      await putShift({
        id: nextId,
        personId,
        date,
        start: cleanStart,
        end: cleanEnd,
        label: finalLabel,
        kind,
        note: note.trim() === '' ? null : note.trim(),
        // Une saisie manuelle est fiable par definition.
        importId: shift?.importId ?? 'manuel',
        confidence: 1,
        updatedAt: Date.now(),
      });

      await refresh();
      onClose();
    } catch (cause) {
      console.error('[shift-editor] enregistrement impossible', cause);
      setError('Enregistrement impossible.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (shift === null) return;
    setBusy(true);
    try {
      await deleteShift(shift.id);
      await refresh();
      onClose();
    } catch (cause) {
      console.error('[shift-editor] suppression impossible', cause);
      setError('Suppression impossible.');
      setBusy(false);
    }
  };

  return (
    <Modal title={shift === null ? 'Nouveau poste' : 'Modifier le poste'} onClose={onClose}>
      {error !== null && <Alert tone="error">{error}</Alert>}

      <p className="muted small" style={{ marginTop: 0 }}>{readableDate}</p>

      <div className="field">
        <label className="field__label" htmlFor="shift-person">Personne</label>
        <select
          id="shift-person"
          className="select"
          value={personId}
          onChange={(event) => setPersonId(event.target.value)}
        >
          {people.length === 0 && <option value="">Aucune personne enregistr&eacute;e</option>}
          {people.map((person) => (
            <option key={person.id} value={person.id}>{person.displayName}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="shift-kind">Type</label>
        <select
          id="shift-kind"
          className="select"
          value={kind}
          onChange={(event) => setKind(event.target.value as ShiftKind)}
        >
          {SHIFT_KINDS.map((value) => (
            <option key={value} value={value}>{SHIFT_KIND_LABELS[value]}</option>
          ))}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label className="field__label" htmlFor="shift-start">D&eacute;but</label>
          <input
            id="shift-start"
            className="input"
            inputMode="numeric"
            placeholder="08:00"
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="shift-end">Fin</label>
          <input
            id="shift-end"
            className="input"
            inputMode="numeric"
            placeholder="16:00"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
        </div>
      </div>
      <p className="field__hint" style={{ marginTop: -8 }}>
        Laisse vide pour un repos ou une absence sur la journ&eacute;e enti&egrave;re.
      </p>

      <div className="field" style={{ marginTop: 16 }}>
        <label className="field__label" htmlFor="shift-label">Libell&eacute;</label>
        <input
          id="shift-label"
          className="input"
          placeholder="Matin, RH, CP&hellip;"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="shift-note">Note</label>
        <input
          id="shift-note"
          className="input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      <div className="btnrow">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void handleSave()}
          disabled={busy || people.length === 0}
        >
          {busy ? <span className="spinner" /> : 'Enregistrer'}
        </button>
        {shift !== null && (
          <button type="button" className="btn btn--danger" onClick={() => void handleDelete()} disabled={busy}>
            Supprimer
          </button>
        )}
      </div>
    </Modal>
  );
}
