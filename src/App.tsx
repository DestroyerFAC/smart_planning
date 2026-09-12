/**
 * Coquille de l'application : barre de titre, navigation temporelle,
 * filtre par personne, vue courante et barre d'onglets.
 *
 * La navigation est en bas de l'ecran (et non en haut) parce que l'app est
 * concue pour un usage a une main sur telephone : c'est la zone que le pouce
 * atteint sans reprise en main.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { AgendaDay } from './ui/AgendaDay';
import { CalendarMonth } from './ui/CalendarMonth';
import { CalendarWeek } from './ui/CalendarWeek';
import { ImportDialog } from './ui/ImportDialog';
import { PeopleView } from './ui/PeopleView';
import { SettingsDialog } from './ui/SettingsDialog';
import {
  addDaysISO,
  addMonthsISO,
  parseISODate,
  startOfWeekISO,
  todayISO,
} from './lib/datetime';
import { usePlanning } from './ui/store';
import type { CalendarView, ISODate } from './types';

const TABS: readonly { readonly view: CalendarView; readonly label: string; readonly icon: string }[] = [
  { view: 'month', label: 'Mois', icon: '\u{1F4C5}' },
  { view: 'week', label: 'Semaine', icon: '\u{1F4CA}' },
  { view: 'day', label: 'Jour', icon: '\u{1F4CB}' },
  { view: 'people', label: 'Collègues', icon: '\u{1F465}' },
];

export function App(): ReactNode {
  const { ready, anchor, view, setAnchor, setView, people, personFilter, togglePersonFilter, clearPersonFilter } =
    usePlanning();
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const title = useMemo(() => buildTitle(view, anchor), [view, anchor]);
  const isToday = anchor === todayISO();

  const step = (direction: 1 | -1): void => {
    switch (view) {
      case 'month': setAnchor(addMonthsISO(anchor, direction)); break;
      case 'week': setAnchor(addDaysISO(anchor, 7 * direction)); break;
      case 'day': setAnchor(addDaysISO(anchor, direction)); break;
      default: break;
    }
  };

  const openDay = (date: ISODate): void => {
    setAnchor(date);
    setView('day');
  };

  if (!ready) {
    return (
      <div className="app">
        <div className="agenda__empty" style={{ alignSelf: 'center' }}>
          <span className="spinner" /> Chargement&hellip;
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="topbar__title">{title}</h1>

        {view !== 'people' && (
          <>
            <button
              type="button"
              className="iconbtn"
              onClick={() => setAnchor(todayISO())}
              disabled={isToday}
              aria-label="Revenir à aujourd’hui"
              title="Aujourd’hui"
            >
              &#8226;
            </button>
            <button type="button" className="iconbtn" onClick={() => step(-1)} aria-label="Précédent">
              &#8249;
            </button>
            <button type="button" className="iconbtn" onClick={() => step(1)} aria-label="Suivant">
              &#8250;
            </button>
          </>
        )}

        <button
          type="button"
          className="iconbtn"
          onClick={() => setShowSettings(true)}
          aria-label="Réglages"
        >
          &#9881;
        </button>
      </header>

      {view !== 'people' && people.length > 1 && (
        <div className="filterbar">
          <button
            type="button"
            className="filterchip"
            aria-pressed={personFilter === null}
            onClick={clearPersonFilter}
          >
            Tous
          </button>
          {people.map((person) => (
            <button
              key={person.id}
              type="button"
              className="filterchip"
              aria-pressed={personFilter?.has(person.id) ?? false}
              onClick={() => togglePersonFilter(person.id)}
            >
              <span
                className="dot"
                style={{ background: person.color, margin: 0 }}
                aria-hidden="true"
              />
              {person.isMe ? 'Moi' : person.displayName.split(' ')[0]}
            </button>
          ))}
        </div>
      )}

      <main className="main">
        {view === 'month' && <CalendarMonth onPickDay={openDay} />}
        {view === 'week' && <CalendarWeek onPickDay={openDay} />}
        {view === 'day' && <AgendaDay />}
        {view === 'people' && <PeopleView />}
      </main>

      <button
        type="button"
        className="fab"
        onClick={() => setShowImport(true)}
        aria-label="Importer un planning"
      >
        +
      </button>

      <nav className="bottomnav" aria-label="Vues">
        {TABS.map((tab) => (
          <button
            key={tab.view}
            type="button"
            className="bottomnav__item"
            aria-current={view === tab.view}
            onClick={() => setView(tab.view)}
          >
            <span className="bottomnav__icon" aria-hidden="true">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </nav>

      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </div>
  );
}

/** Intitule de la barre de titre, adapte a la vue courante. */
function buildTitle(view: CalendarView, anchor: ISODate): string {
  if (view === 'people') return 'Collègues';

  const date = parseISODate(anchor);
  if (!date) return anchor;

  if (view === 'month') {
    return date.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  }

  if (view === 'day') {
    // 'short' plutot que 'long' : "samedi 12 septembre" deborde de la barre.
    return date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long' });
  }

  const start = parseISODate(startOfWeekISO(anchor, 1));
  const end = parseISODate(addDaysISO(startOfWeekISO(anchor, 1), 6));
  if (!start || !end) return anchor;

  // Mois identique de part et d'autre : on ne le repete pas ("8 - 14 sept.").
  const sameMonth = start.getMonth() === end.getMonth();
  const from = start.toLocaleDateString('fr-FR', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
  const to = end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return `${from} – ${to}`;
}
