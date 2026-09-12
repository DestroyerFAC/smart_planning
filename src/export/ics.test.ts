/**
 * Tests de la generation iCalendar.
 *
 * C'est le chemin qui amene le planning sur l'ecran d'accueil de l'iPhone :
 * un fichier mal forme est silencieusement refuse par l'app Calendrier, sans
 * message d'erreur exploitable. Les regles de la RFC 5545 les plus faciles a
 * enfreindre sont donc verrouillees ici.
 */
import { describe, expect, it } from 'vitest';
import { buildIcs, DEFAULT_ICS_OPTIONS } from './ics';
import type { Person, Shift, ShiftKind } from '../types';

const PERSON: Person = {
  id: 'p_1',
  displayName: 'Jean Dupont',
  normalizedName: 'dupont jean',
  color: '#1a73e8',
  isMe: true,
  aliases: ['Jean Dupont'],
  createdAt: 1,
  updatedAt: 1,
};

function shift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: 's_1',
    personId: 'p_1',
    date: '2026-09-12',
    start: '08:00',
    end: '16:00',
    label: 'Matin',
    kind: 'work' as ShiftKind,
    note: null,
    importId: 'i_1',
    confidence: 0.95,
    updatedAt: 1,
    ...overrides,
  };
}

/** Deplie les lignes repliees, pour tester le contenu logique. */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, '');
}

describe('structure du fichier', () => {
  it('encadre le contenu et termine par un saut de ligne', () => {
    const ics = buildIcs([shift()], [PERSON]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('utilise CRLF partout, jamais LF seul', () => {
    const ics = buildIcs([shift()], [PERSON]);
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it('produit un calendrier valide meme sans aucun poste', () => {
    const ics = buildIcs([], [PERSON]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});

describe('horaires', () => {
  it('ecrit une heure flottante, sans Z ni TZID', () => {
    // Un instant UTC decalerait tout le planning au premier voyage ou au
    // changement d'heure : un poste a 08:00 commence a 08:00, point.
    const ics = unfold(buildIcs([shift()], [PERSON]));
    expect(ics).toContain('DTSTART:20260912T080000');
    expect(ics).toContain('DTEND:20260912T160000');
    expect(ics).not.toMatch(/DTSTART[^\r\n]*Z/);
    expect(ics).not.toContain('TZID');
  });

  it('reporte la fin d un poste de nuit au lendemain', () => {
    const ics = unfold(buildIcs([shift({ start: '22:00', end: '06:00' })], [PERSON]));
    expect(ics).toContain('DTSTART:20260912T220000');
    // Sans le report, DTEND precederait DTSTART et l'evenement serait rejete.
    expect(ics).toContain('DTEND:20260913T060000');
  });

  it('donne une duree par defaut quand la fin est inconnue', () => {
    const ics = unfold(buildIcs([shift({ end: null })], [PERSON]));
    expect(ics).toContain('DTSTART:20260912T080000');
    expect(ics).toContain('DURATION:PT1H');
  });

  it('ecrit une journee entiere avec un DTEND exclusif', () => {
    const ics = unfold(buildIcs([shift({ start: null, end: null, kind: 'rest', label: 'RH' })], [PERSON]));
    expect(ics).toContain('DTSTART;VALUE=DATE:20260912');
    // DTEND est exclusif dans la RFC : le lendemain, pas le jour meme.
    expect(ics).toContain('DTEND;VALUE=DATE:20260913');
    expect(ics).toContain('TRANSP:TRANSPARENT');
  });
});

describe('echappement et repliement', () => {
  it('echappe les caracteres reserves', () => {
    const ics = unfold(buildIcs([shift({ label: 'Poste; A, B\\C' })], [PERSON]));
    expect(ics).toContain('SUMMARY:Poste\\; A\\, B\\\\C');
  });

  it('transforme les retours a la ligne d une note en \\n', () => {
    const ics = unfold(buildIcs([shift({ note: 'ligne 1\nligne 2' })], [PERSON]));
    expect(ics).toContain('ligne 1\\nligne 2');
  });

  it('replie les lignes au-dela de 75 octets', () => {
    const ics = buildIcs([shift({ label: 'Poste tres long '.repeat(8) })], [PERSON]);
    expect(ics).toContain('\r\n ');
    // Le contenu logique doit survivre au repliement.
    expect(unfold(ics)).toContain('SUMMARY:Poste tres long Poste tres long');
  });

  it('ne coupe jamais au milieu d un caractere accentue', () => {
    const ics = buildIcs([shift({ label: 'é'.repeat(80) })], [PERSON]);
    const encoder = new TextEncoder();
    for (const line of ics.split('\r\n')) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    // Un octet coupe produirait un caractere de remplacement a la reassemblage.
    expect(unfold(ics)).not.toContain('�');
    expect(unfold(ics)).toContain('é'.repeat(80));
  });
});

describe('options', () => {
  it('prefixe du nom de la personne pour un agenda d equipe', () => {
    const ics = unfold(buildIcs([shift()], [PERSON], { ...DEFAULT_ICS_OPTIONS, includePersonName: true }));
    expect(ics).toContain('SUMMARY:Jean Dupont');
  });

  it('peut exclure repos et absences', () => {
    const shifts = [shift(), shift({ id: 's_2', kind: 'rest', start: null, end: null })];
    const ics = unfold(buildIcs(shifts, [PERSON], { ...DEFAULT_ICS_OPTIONS, includeNonWork: false }));
    expect((ics.match(/BEGIN:VEVENT/g) ?? [])).toHaveLength(1);
  });

  it('signale une lecture incertaine dans la description', () => {
    const ics = unfold(buildIcs([shift({ confidence: 0.3 })], [PERSON]));
    expect(ics).toContain('Lecture incertaine');
  });

  it('donne a chaque evenement un UID stable derive du poste', () => {
    const first = unfold(buildIcs([shift()], [PERSON]));
    const second = unfold(buildIcs([shift()], [PERSON]));
    expect(first).toContain('UID:s_1@smart-planning.local');
    expect(second).toContain('UID:s_1@smart-planning.local');
  });
});
