/**
 * Vue collegues : qui est enregistre, qui suis-je, et correction des
 * rapprochements de noms.
 *
 * La fusion manuelle est le filet de securite du rapprochement automatique :
 * celui-ci est volontairement prudent et cree parfois deux fiches pour une
 * meme personne. Mieux vaut une fusion en deux taps qu'un planning melange.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Avatar, Modal } from './components';
import {
  deletePerson,
  getShiftsForPerson,
  mergePeople,
  renamePerson,
  setMyPerson,
} from '../db/repo';
import { nameSimilarity } from '../ingest/names';
import { todayISO } from '../lib/datetime';
import { usePlanning } from './store';
import type { Person } from '../types';

/** En deca de ce score, on ne propose pas de fusion : trop de faux positifs. */
const SUGGESTION_THRESHOLD = 0.6;

export function PeopleView(): ReactNode {
  const { people, refresh, settings } = usePlanning();
  const [selected, setSelected] = useState<Person | null>(null);
  const [counts, setCounts] = useState<ReadonlyMap<string, { total: number; upcoming: number }>>(new Map());

  // Les compteurs interrogent toute la base, hors de la fenetre chargee par le
  // store : ils sont donc calcules ici, une fois, a l'ouverture de la vue.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const today = todayISO();
      const entries = await Promise.all(people.map(async (person) => {
        const shifts = await getShiftsForPerson(person.id);
        return [person.id, {
          total: shifts.length,
          upcoming: shifts.filter((shift) => shift.date >= today).length,
        }] as const;
      }));
      if (!cancelled) setCounts(new Map(entries));
    })();
    return () => { cancelled = true; };
  }, [people]);

  if (people.length === 0) {
    return (
      <div className="people">
        <div className="agenda__empty">
          <p>Aucun coll&egrave;gue enregistr&eacute;.</p>
          <p className="muted small">
            Importe une photo de planning : les noms qui s&rsquo;y trouvent appara&icirc;tront ici.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="people">
      {settings.myPersonId === null && (
        <Alert tone="warn" title="Indique qui tu es">
          <p className="alert__hint">
            Touche ton nom dans la liste puis &laquo;&nbsp;C&rsquo;est moi&nbsp;&raquo;. Tu pourras
            ensuite filtrer ton planning et l&rsquo;exporter seul vers le Calendrier.
          </p>
        </Alert>
      )}

      {people.map((person) => {
        const count = counts.get(person.id);
        return (
          <button
            key={person.id}
            type="button"
            className="person"
            onClick={() => setSelected(person)}
          >
            <Avatar person={person} />
            <span className="person__body">
              <span className="person__name">{person.displayName}</span>
              <span className="person__sub">
                {count === undefined
                  ? '…'
                  : `${count.total} poste${count.total > 1 ? 's' : ''} · ${count.upcoming} à venir`}
              </span>
            </span>
            {person.isMe && <span className="badge">Moi</span>}
          </button>
        );
      })}

      {selected !== null && (
        <PersonSheet
          person={selected}
          people={people}
          onClose={() => setSelected(null)}
          onChanged={() => { void refresh(); setSelected(null); }}
        />
      )}
    </div>
  );
}

interface PersonSheetProps {
  readonly person: Person;
  readonly people: readonly Person[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

function PersonSheet({ person, people, onClose, onChanged }: PersonSheetProps): ReactNode {
  const [name, setName] = useState(person.displayName);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** Doublons probables, tries du plus ressemblant au moins ressemblant. */
  const suggestions = useMemo(
    () => people
      .filter((candidate) => candidate.id !== person.id)
      .map((candidate) => ({ candidate, score: nameSimilarity(person.displayName, candidate.displayName) }))
      .filter((entry) => entry.score >= SUGGESTION_THRESHOLD)
      .sort((a, b) => b.score - a.score),
    [people, person],
  );

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (cause) {
      console.error('[people] action impossible', cause);
      setBusy(false);
    }
  };

  return (
    <Modal title={person.displayName} onClose={onClose}>
      <div className="field">
        <label className="field__label" htmlFor="person-name">Nom affich&eacute;</label>
        <input
          id="person-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="field__hint">
          Graphies reconnues sur les plannings : {person.aliases.join(', ')}
        </p>
      </div>

      <div className="btnrow">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || name.trim() === person.displayName}
          onClick={() => void run(() => renamePerson(person.id, name))}
        >
          Renommer
        </button>
        {!person.isMe && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run(() => setMyPerson(person.id))}
          >
            C&rsquo;est moi
          </button>
        )}
      </div>

      {suggestions.length > 0 && (
        <>
          <p className="section-title">Doublon probable</p>
          <p className="muted small" style={{ marginTop: 0 }}>
            Fusionner d&eacute;place tous les postes de cette fiche vers celle choisie,
            puis supprime celle-ci.
          </p>
          {suggestions.map(({ candidate, score }) => (
            <div key={candidate.id} className="list-row">
              <Avatar person={candidate} />
              <span className="list-row__body">
                <span className="list-row__title">{candidate.displayName}</span>
                <span className="list-row__sub">{Math.round(score * 100)}&nbsp;% de ressemblance</span>
              </span>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void run(() => mergePeople(person.id, candidate.id))}
              >
                Fusionner
              </button>
            </div>
          ))}
        </>
      )}

      <div className="divider" />

      {confirmDelete ? (
        <Alert tone="error" title="Supprimer d&eacute;finitivement ?">
          <p className="alert__hint">
            Tous les postes de {person.displayName} seront effac&eacute;s. Un nouvel import les
            recr&eacute;era si la personne figure encore sur le planning.
          </p>
          <div className="btnrow" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={() => void run(() => deletePerson(person.id))}
            >
              Oui, supprimer
            </button>
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
              Annuler
            </button>
          </div>
        </Alert>
      ) : (
        <button
          type="button"
          className="btn btn--block"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          Supprimer cette personne
        </button>
      )}
    </Modal>
  );
}
