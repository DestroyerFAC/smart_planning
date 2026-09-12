/**
 * Vue semaine : grille horaire avec les postes positionnes a l'heure reelle.
 *
 * C'est la vue qui repond a "je veux voir qui travaille quand" d'un seul
 * regard. Deux points delicats y sont traites :
 *  - les postes qui se chevauchent, repartis en colonnes (comme Google Agenda) ;
 *  - les postes de nuit, tronques a minuit puis repris le lendemain, car un
 *    bloc qui deborderait de la colonne casserait la grille.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  addDaysISO,
  crossesMidnight,
  minutesOfDay,
  parseISODate,
  startOfWeekISO,
  todayISO,
} from '../lib/datetime';
import { shiftColor, timeRangeLabel } from './components';
import { usePeopleIndex, usePlanning, useShiftsByDate, useVisibleShifts } from './store';
import type { ISODate, Shift } from '../types';

/** Hauteur d'une heure, en pixels. Doit rester synchrone avec styles.css. */
const HOUR_HEIGHT = 48;
const MINUTES_PER_DAY = 24 * 60;
/** Hauteur minimale d'un bloc, pour qu'un poste court reste cliquable. */
const MIN_BLOCK_HEIGHT = 16;

interface PositionedShift {
  readonly shift: Shift;
  readonly topMinutes: number;
  readonly durationMinutes: number;
  /** Colonne occupee parmi `lanes`, pour gerer les chevauchements. */
  readonly lane: number;
  readonly lanes: number;
  /** Vrai si le bloc est la fin d'un poste de nuit commence la veille. */
  readonly isContinuation: boolean;
}

interface DaySegment {
  readonly shift: Shift;
  readonly from: number;
  readonly to: number;
  readonly isContinuation: boolean;
}

/**
 * Decoupe les postes d'une journee en segments affichables.
 * Un poste de nuit produit deux segments : la fin de soiree le jour J, et le
 * debut de matinee le jour J+1 (ajoute par l'appelant).
 */
function segmentsForDay(dayShifts: readonly Shift[], previousDayShifts: readonly Shift[]): DaySegment[] {
  const segments: DaySegment[] = [];

  for (const shift of dayShifts) {
    if (shift.start === null) continue;
    const from = minutesOfDay(shift.start);
    const to = shift.end === null
      ? Math.min(from + 60, MINUTES_PER_DAY)
      : crossesMidnight(shift.start, shift.end)
        ? MINUTES_PER_DAY
        : minutesOfDay(shift.end);
    segments.push({ shift, from, to, isContinuation: false });
  }

  // Retombees de la veille : un poste 22:00-06:00 occupe aussi 00:00-06:00 ici.
  for (const shift of previousDayShifts) {
    if (shift.start === null || shift.end === null) continue;
    if (!crossesMidnight(shift.start, shift.end)) continue;
    segments.push({ shift, from: 0, to: minutesOfDay(shift.end), isContinuation: true });
  }

  return segments.sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * Repartit les segments en colonnes.
 *
 * On constitue des grappes de segments qui se chevauchent de proche en proche,
 * puis on attribue a chacun la premiere colonne libre. Toute la grappe partage
 * le meme nombre de colonnes, ce qui evite des largeurs incoherentes entre
 * deux blocs voisins.
 */
function layoutDay(segments: readonly DaySegment[]): PositionedShift[] {
  const positioned: PositionedShift[] = [];
  let cluster: DaySegment[] = [];
  let clusterEnd = -1;

  const flush = (): void => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const assignments = cluster.map((segment) => {
      let lane = laneEnds.findIndex((end) => end <= segment.from);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(segment.to);
      } else {
        laneEnds[lane] = segment.to;
      }
      return { segment, lane };
    });

    for (const { segment, lane } of assignments) {
      positioned.push({
        shift: segment.shift,
        topMinutes: segment.from,
        durationMinutes: Math.max(segment.to - segment.from, 1),
        lane,
        lanes: laneEnds.length,
        isContinuation: segment.isContinuation,
      });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const segment of segments) {
    if (cluster.length > 0 && segment.from >= clusterEnd) flush();
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.to);
  }
  flush();

  return positioned;
}

export function CalendarWeek({ onPickDay }: { readonly onPickDay: (date: ISODate) => void }): ReactNode {
  const { anchor, settings } = usePlanning();
  const shifts = useVisibleShifts();
  const byDate = useShiftsByDate(shifts);
  const peopleById = usePeopleIndex();
  const today = todayISO();
  const scrollRef = useRef<HTMLDivElement>(null);

  const weekDays = useMemo(() => {
    const first = startOfWeekISO(anchor, settings.weekStartsOn);
    return Array.from({ length: 7 }, (_, index) => addDaysISO(first, index));
  }, [anchor, settings.weekStartsOn]);

  // Cadrage initial sur 6 h du matin : demarrer a minuit afficherait une zone
  // vide sur la plupart des plannings.
  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = 6 * HOUR_HEIGHT;
  }, []);

  const allDayByDay = useMemo(
    () => weekDays.map((date) => (byDate.get(date) ?? []).filter((shift) => shift.start === null)),
    [weekDays, byDate],
  );

  const layoutByDay = useMemo(
    () => weekDays.map((date) => layoutDay(
      segmentsForDay(byDate.get(date) ?? [], byDate.get(addDaysISO(date, -1)) ?? []),
    )),
    [weekDays, byDate],
  );

  const hasAllDay = allDayByDay.some((entries) => entries.length > 0);

  return (
    <div ref={scrollRef} className="week" style={{ height: '100%', overflow: 'auto' }}>
      {/* En-tete des jours et bande "journee entiere" dans un seul conteneur
          collant : deux elements colles a top: 0 se superposeraient. */}
      <div className="week__sticky">
        <div className="week__header">
          <div aria-hidden="true" />
          {weekDays.map((date) => {
            const parsed = parseISODate(date);
            return (
              <button
                key={date}
                type="button"
                className={`week__daybtn${date === today ? ' week__daybtn--today' : ''}`}
                onClick={() => onPickDay(date)}
              >
                <span>{parsed?.toLocaleDateString('fr-FR', { weekday: 'narrow' })}</span>
                <span className="week__daynum">{Number(date.slice(8, 10))}</span>
              </button>
            );
          })}
        </div>

        {hasAllDay && (
          <div className="week__allday">
            <div className="week__allday-label">Jour</div>
            {allDayByDay.map((entries, index) => (
              <div key={weekDays[index]} className="week__allday-cell">
                {entries.map((shift) => {
                  const person = peopleById.get(shift.personId);
                  return (
                    <span
                      key={shift.id}
                      className="chip"
                      style={{ background: shiftColor(shift.kind, person?.color ?? '#5f6368') }}
                    >
                      {shift.label}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="week__body">
        <div className="week__hours">
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="week__hour">
              {hour === 0 ? '' : `${hour.toString().padStart(2, '0')}:00`}
            </div>
          ))}
        </div>

        {weekDays.map((date, dayIndex) => (
          <div key={date} className="week__col" style={{ height: 24 * HOUR_HEIGHT }}>
            {(layoutByDay[dayIndex] ?? []).map((item) => {
              const person = peopleById.get(item.shift.personId);
              const background = shiftColor(item.shift.kind, person?.color ?? '#5f6368');
              const widthPercent = 100 / item.lanes;

              return (
                <button
                  key={`${item.shift.id}-${item.isContinuation ? 'next' : 'main'}`}
                  type="button"
                  className="week__event"
                  onClick={() => onPickDay(date)}
                  style={{
                    top: (item.topMinutes / 60) * HOUR_HEIGHT,
                    height: Math.max((item.durationMinutes / 60) * HOUR_HEIGHT, MIN_BLOCK_HEIGHT),
                    left: `${item.lane * widthPercent}%`,
                    width: `calc(${widthPercent}% - 2px)`,
                    background,
                    // Le segment repris le lendemain est legerement estompe pour
                    // qu'on ne le compte pas comme un second poste.
                    opacity: item.isContinuation ? 0.75 : 1,
                  }}
                  title={`${person?.displayName ?? ''} ${timeRangeLabel(item.shift)}`}
                >
                  <span className="week__event-title">
                    {person?.displayName.split(' ')[0] ?? item.shift.label}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
