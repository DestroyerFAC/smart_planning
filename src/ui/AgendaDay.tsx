/**
 * Vue jour : liste chronologique des postes, avec edition au tap.
 * C'est la vue la plus utile au quotidien sur telephone — celle qu'on ouvre
 * le matin pour savoir avec qui on travaille.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ShiftEditor } from './ShiftEditor';
import { shiftColor, timeRangeLabel } from './components';
import { parseISODate, shiftDurationMinutes } from '../lib/datetime';
import { SHIFT_KIND_LABELS } from '../types';
import { usePeopleIndex, usePlanning, useVisibleShifts } from './store';
import type { Shift } from '../types';

export function AgendaDay(): ReactNode {
  const { anchor, personFilter } = usePlanning();
  const shifts = useVisibleShifts();
  const peopleById = usePeopleIndex();
  const [editing, setEditing] = useState<Shift | null>(null);
  const [creating, setCreating] = useState(false);

  const dayShifts = useMemo(
    () => shifts.filter((shift) => shift.date === anchor),
    [shifts, anchor],
  );

  const totalWorkedMinutes = useMemo(
    () => dayShifts.reduce((sum, shift) => (
      shift.kind === 'work' && shift.start !== null && shift.end !== null
        ? sum + shiftDurationMinutes(shift.start, shift.end)
        : sum
    ), 0),
    [dayShifts],
  );

  // Le total additionne les postes AFFICHES : sans filtre c'est l'equipe
  // entiere, avec un filtre sur une personne c'est la sienne.
  const totalLabel = useMemo(() => {
    if (personFilter === null || personFilter.size !== 1) return 'Total \u00e9quipe';
    const only = [...personFilter][0];
    const name = only === undefined ? undefined : peopleById.get(only)?.displayName.split(' ')[0];
    return name === undefined ? 'Total' : `Total ${name}`;
  }, [personFilter, peopleById]);

  const readableDate = parseISODate(anchor)?.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }) ?? anchor;

  return (
    <div className="agenda">
      <p className="agenda__date">{readableDate}</p>

      {dayShifts.length === 0 ? (
        <div className="agenda__empty">
          <p>Aucun poste ce jour-l&agrave;.</p>
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            Ajouter un poste
          </button>
        </div>
      ) : (
        <>
          {dayShifts.map((shift) => {
            const person = peopleById.get(shift.personId);
            const color = shiftColor(shift.kind, person?.color ?? '#5f6368');
            return (
              <button
                key={shift.id}
                type="button"
                className="agenda__row"
                onClick={() => setEditing(shift)}
              >
                <span className="agenda__time">{timeRangeLabel(shift)}</span>
                <span>
                  <span className="agenda__name">
                    <span className="dot" style={{ background: color }} />
                    {person?.displayName ?? 'Inconnu'}
                  </span>
                  <span className="agenda__meta" style={{ display: 'block' }}>
                    {shift.label}
                    {shift.kind !== 'work' && ` · ${SHIFT_KIND_LABELS[shift.kind]}`}
                    {shift.note !== null && ` · ${shift.note}`}
                    {/* Signale explicitement les cases que l'IA a mal lues. */}
                    {shift.confidence < 0.6 && ' · ⚠️ à vérifier'}
                  </span>
                </span>
              </button>
            );
          })}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
            <span className="muted small">
              {totalWorkedMinutes > 0 && `${totalLabel} : ${formatDuration(totalWorkedMinutes)}`}
            </span>
            <button type="button" className="btn" onClick={() => setCreating(true)}>Ajouter</button>
          </div>
        </>
      )}

      {editing !== null && (
        <ShiftEditor date={anchor} shift={editing} onClose={() => setEditing(null)} />
      )}
      {creating && (
        <ShiftEditor date={anchor} shift={null} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest.toString().padStart(2, '0')}`;
}
