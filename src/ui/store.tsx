/**
 * Etat global de l'application.
 *
 * Un contexte React suffit largement ici : l'etat tient en une poignee de
 * champs et les mutations passent toutes par IndexedDB, qui est la source de
 * verite. Ajouter Redux ou Zustand n'apporterait qu'une couche d'indirection.
 *
 * Regle de chargement : on ne garde en memoire que les postes de la fenetre
 * VISIBLE (le mois affiche, elargi d'un mois de chaque cote pour que la
 * navigation soit instantanee), jamais toute la base.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getShiftsBetween,
  listPeople,
  loadSettings,
  saveSettings as persistSettings,
} from '../db/repo';
import {
  addMonthsISO,
  endOfMonthISO,
  startOfMonthISO,
  todayISO,
} from '../lib/datetime';
import { DEFAULT_SETTINGS } from '../db/schema';
import type { CalendarView, ISODate, Person, Settings, Shift } from '../types';

interface PlanningContextValue {
  readonly ready: boolean;
  readonly settings: Settings;
  readonly people: readonly Person[];
  /** Postes de la fenetre chargee, tries par date puis heure de debut. */
  readonly shifts: readonly Shift[];
  readonly anchor: ISODate;
  readonly view: CalendarView;
  /** `null` = aucun filtre, toutes les personnes sont affichees. */
  readonly personFilter: ReadonlySet<string> | null;

  setAnchor: (date: ISODate) => void;
  setView: (view: CalendarView) => void;
  togglePersonFilter: (personId: string) => void;
  clearPersonFilter: () => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  /** Recharge personnes + postes depuis IndexedDB. A appeler apres toute ecriture. */
  refresh: () => Promise<void>;
}

const PlanningContext = createContext<PlanningContextValue | null>(null);

/** Fenetre chargee autour du mois ancre : un mois de marge de chaque cote. */
function windowFor(anchor: ISODate): { start: ISODate; end: ISODate } {
  return {
    start: startOfMonthISO(addMonthsISO(anchor, -1)),
    end: endOfMonthISO(addMonthsISO(anchor, 1)),
  };
}

/** Tri d'affichage : par date, puis heure, les journees entieres en tete. */
function compareShifts(a: Shift, b: Shift): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.start === b.start) return a.label.localeCompare(b.label, 'fr');
  if (a.start === null) return -1;
  if (b.start === null) return 1;
  return a.start < b.start ? -1 : 1;
}

export function PlanningProvider({ children }: { children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [people, setPeople] = useState<readonly Person[]>([]);
  const [shifts, setShifts] = useState<readonly Shift[]>([]);
  const [anchor, setAnchorState] = useState<ISODate>(todayISO);
  const [view, setViewState] = useState<CalendarView>('month');
  const [personFilter, setPersonFilter] = useState<ReadonlySet<string> | null>(null);

  const loadWindow = useCallback(async (target: ISODate) => {
    const { start, end } = windowFor(target);
    const [nextPeople, nextShifts] = await Promise.all([
      listPeople(),
      getShiftsBetween(start, end),
    ]);
    setPeople(nextPeople);
    setShifts([...nextShifts].sort(compareShifts));
  }, []);

  // Amorcage : reglages d'abord (ils portent la derniere vue utilisee),
  // puis les donnees de la fenetre courante.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await loadSettings();
        if (cancelled) return;
        setSettings(stored);
        setViewState(stored.lastView);
        await loadWindow(todayISO());
      } catch (cause) {
        console.error('[store] Chargement initial impossible', cause);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [loadWindow]);

  const setAnchor = useCallback((date: ISODate) => {
    setAnchorState((previous) => {
      // Rechargement uniquement si l'on change de mois : naviguer d'un jour a
      // l'autre dans le meme mois ne doit pas relancer une requete.
      if (previous.slice(0, 7) !== date.slice(0, 7)) void loadWindow(date);
      return date;
    });
  }, [loadWindow]);

  const setView = useCallback((next: CalendarView) => {
    setViewState(next);
    // Persistance opportuniste : un echec ici ne doit pas casser la navigation.
    void persistSettings({ lastView: next }).catch(() => undefined);
  }, []);

  const togglePersonFilter = useCallback((personId: string) => {
    setPersonFilter((current) => {
      const next = new Set(current ?? []);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      // Un filtre vide equivaut a pas de filtre : evite un ecran vide deroutant.
      return next.size === 0 ? null : next;
    });
  }, []);

  const clearPersonFilter = useCallback(() => setPersonFilter(null), []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const merged = await persistSettings(patch);
    setSettings(merged);
  }, []);

  const refresh = useCallback(async () => {
    const [stored] = await Promise.all([loadSettings(), loadWindow(anchor)]);
    setSettings(stored);
  }, [anchor, loadWindow]);

  const value = useMemo<PlanningContextValue>(() => ({
    ready,
    settings,
    people,
    shifts,
    anchor,
    view,
    personFilter,
    setAnchor,
    setView,
    togglePersonFilter,
    clearPersonFilter,
    updateSettings,
    refresh,
  }), [
    ready, settings, people, shifts, anchor, view, personFilter,
    setAnchor, setView, togglePersonFilter, clearPersonFilter, updateSettings, refresh,
  ]);

  return <PlanningContext.Provider value={value}>{children}</PlanningContext.Provider>;
}

export function usePlanning(): PlanningContextValue {
  const context = useContext(PlanningContext);
  if (!context) throw new Error('usePlanning doit etre utilise dans <PlanningProvider>');
  return context;
}

/** Postes de la fenetre, filtres par la selection de personnes en cours. */
export function useVisibleShifts(): readonly Shift[] {
  const { shifts, personFilter } = usePlanning();
  return useMemo(
    () => (personFilter === null ? shifts : shifts.filter((s) => personFilter.has(s.personId))),
    [shifts, personFilter],
  );
}

/** Index personne -> fiche, pour eviter un `find` dans chaque cellule rendue. */
export function usePeopleIndex(): ReadonlyMap<string, Person> {
  const { people } = usePlanning();
  return useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
}

/** Regroupe les postes par date : structure attendue par toutes les vues. */
export function useShiftsByDate(shifts: readonly Shift[]): ReadonlyMap<ISODate, Shift[]> {
  return useMemo(() => {
    const map = new Map<ISODate, Shift[]>();
    for (const shift of shifts) {
      const bucket = map.get(shift.date);
      if (bucket) bucket.push(shift);
      else map.set(shift.date, [shift]);
    }
    return map;
  }, [shifts]);
}
