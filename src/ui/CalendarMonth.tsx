/**
 * Vue mois : grille 7 x 6, comme Google Agenda.
 *
 * Six semaines sont toujours rendues, meme quand le mois en occupe cinq. Une
 * hauteur de grille constante evite que la mise en page saute a chaque
 * changement de mois, ce qui est tres desagreable au doigt.
 */
import { useMemo, type ReactNode } from 'react';
import { addDaysISO, parseISODate, startOfMonthISO, startOfWeekISO, todayISO } from '../lib/datetime';
import { shiftColor, timeRangeLabel } from './components';
import { usePeopleIndex, usePlanning, useShiftsByDate, useVisibleShifts } from './store';
import type { ISODate } from '../types';

const WEEKDAYS_FROM_MONDAY = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'] as const;
/** Nombre de pastilles avant le "+N", calibre sur la hauteur d'une cellule. */
const MAX_CHIPS = 3;
const GRID_WEEKS = 6;

export function CalendarMonth({ onPickDay }: { readonly onPickDay: (date: ISODate) => void }): ReactNode {
  const { anchor, settings, personFilter } = usePlanning();
  const shifts = useVisibleShifts();
  const byDate = useShiftsByDate(shifts);
  const peopleById = usePeopleIndex();
  const today = todayISO();

  const weekdayLabels = useMemo(() => {
    const labels = [...WEEKDAYS_FROM_MONDAY];
    // weekStartsOn = 0 signifie dimanche : on fait tourner le tableau.
    if (settings.weekStartsOn === 0) labels.unshift(labels.pop() as (typeof WEEKDAYS_FROM_MONDAY)[number]);
    return labels;
  }, [settings.weekStartsOn]);

  const days = useMemo(() => {
    const firstCell = startOfWeekISO(startOfMonthISO(anchor), settings.weekStartsOn);
    return Array.from({ length: GRID_WEEKS * 7 }, (_, index) => addDaysISO(firstCell, index));
  }, [anchor, settings.weekStartsOn]);

  const currentMonth = anchor.slice(0, 7);

  return (
    <div>
      <div className="month__weekdays" role="row">
        {weekdayLabels.map((label) => (
          <div key={label} className="month__weekday" role="columnheader">{label}</div>
        ))}
      </div>

      <div className="month__grid" role="grid" aria-label="Calendrier mensuel">
        {days.map((date) => {
          const dayShifts = byDate.get(date) ?? [];
          const isOutside = date.slice(0, 7) !== currentMonth;
          const isToday = date === today;
          const dayNumber = Number(date.slice(8, 10));

          const classes = [
            'month__cell',
            isOutside ? 'month__cell--outside' : '',
            isToday ? 'month__cell--today' : '',
          ].filter(Boolean).join(' ');

          return (
            <button
              key={date}
              type="button"
              className={classes}
              onClick={() => onPickDay(date)}
              aria-label={describeDay(date, dayShifts.length)}
            >
              <span className="month__daynum">{dayNumber}</span>

              <span className="month__chips">
                {dayShifts.slice(0, MAX_CHIPS).map((shift) => {
                  const person = peopleById.get(shift.personId);
                  const background = shiftColor(shift.kind, person?.color ?? '#5f6368');
                  // Quand une seule personne est filtree, son nom est redondant :
                  // on affiche l'horaire, bien plus utile.
                  const text = personFilter?.size === 1
                    ? timeRangeLabel(shift)
                    : person?.displayName.split(' ')[0] ?? shift.label;
                  return (
                    <span key={shift.id} className="chip" style={{ background }}>
                      {text}
                    </span>
                  );
                })}
                {dayShifts.length > MAX_CHIPS && (
                  <span className="month__more">+{dayShifts.length - MAX_CHIPS}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Libelle vocalise par les lecteurs d'ecran pour une cellule de jour. */
function describeDay(date: ISODate, count: number): string {
  const parsed = parseISODate(date);
  const readable = parsed
    ? parsed.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
    : date;
  if (count === 0) return `${readable}, aucun poste`;
  return `${readable}, ${count} poste${count > 1 ? 's' : ''}`;
}
