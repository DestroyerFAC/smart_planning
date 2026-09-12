/**
 * Tests des utilitaires de date/heure.
 *
 * Ce module est la source d'une categorie de bugs particulierement sournoise
 * sur un calendrier : un decalage d'un jour qui n'apparait qu'au changement
 * d'heure, ou pour les utilisateurs d'un certain fuseau. Les cas limites sont
 * donc verifies explicitement.
 */
import { describe, expect, it } from 'vitest';
import {
  addDaysISO,
  addMonthsISO,
  crossesMidnight,
  datesBetween,
  endOfMonthISO,
  isValidISODate,
  minutesOfDay,
  normalizeTime,
  parseISODate,
  shiftDurationMinutes,
  startOfWeekISO,
  toISODate,
} from './datetime';

describe('isValidISODate', () => {
  it('accepte une date reelle', () => {
    expect(isValidISODate('2026-09-12')).toBe(true);
  });

  it('rejette une date que la seule regex laisserait passer', () => {
    expect(isValidISODate('2026-02-31')).toBe(false);
    expect(isValidISODate('2026-13-01')).toBe(false);
  });

  it('accepte le 29 fevrier d une annee bissextile et refuse sinon', () => {
    expect(isValidISODate('2028-02-29')).toBe(true);
    expect(isValidISODate('2026-02-29')).toBe(false);
  });

  it('rejette les formats approximatifs', () => {
    expect(isValidISODate('12/09/2026')).toBe(false);
    expect(isValidISODate('2026-9-12')).toBe(false);
  });
});

describe('toISODate', () => {
  it('utilise les composantes LOCALES, pas UTC', () => {
    // 23 h heure locale : toISOString() renverrait le lendemain dans les
    // fuseaux a l'est de Greenwich, decalant tout le planning d'un jour.
    expect(toISODate(new Date(2026, 8, 12, 23, 30))).toBe('2026-09-12');
    expect(toISODate(new Date(2026, 0, 1, 0, 15))).toBe('2026-01-01');
  });
});

describe('addDaysISO', () => {
  it('franchit les fins de mois et d annee', () => {
    expect(addDaysISO('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('franchit le 29 fevrier d une annee bissextile', () => {
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('reste juste au passage a l heure d ete', () => {
    // Nuit du 28 au 29 mars 2026 en Europe : la journee ne fait que 23 h.
    // Une implementation par ajout de 86 400 000 ms se tromperait ici.
    expect(addDaysISO('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDaysISO('2026-03-29', 1)).toBe('2026-03-30');
  });
});

describe('datesBetween', () => {
  it('inclut les deux bornes', () => {
    expect(datesBetween('2026-09-07', '2026-09-09'))
      .toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
  });

  it('renvoie une liste vide si les bornes sont inversees', () => {
    expect(datesBetween('2026-09-09', '2026-09-07')).toEqual([]);
  });

  it('borne une plage aberrante pour ne pas figer l interface', () => {
    expect(datesBetween('2020-01-01', '2030-01-01').length).toBeLessThanOrEqual(400);
  });
});

describe('normalizeTime', () => {
  it('accepte les notations francaises courantes', () => {
    expect(normalizeTime('8h')).toBe('08:00');
    expect(normalizeTime('8h30')).toBe('08:30');
    expect(normalizeTime('8 h 30')).toBe('08:30');
    expect(normalizeTime('08:30')).toBe('08:30');
    expect(normalizeTime('08.30')).toBe('08:30');
    expect(normalizeTime('0830')).toBe('08:30');
    expect(normalizeTime('22:00')).toBe('22:00');
  });

  it('rejette ce qui n est pas une heure', () => {
    expect(normalizeTime('25:00')).toBeNull();
    expect(normalizeTime('08:70')).toBeNull();
    expect(normalizeTime('RH')).toBeNull();
    expect(normalizeTime('')).toBeNull();
    expect(normalizeTime(null)).toBeNull();
  });
});

describe('postes de nuit', () => {
  it('detecte le passage de minuit', () => {
    expect(crossesMidnight('22:00', '06:00')).toBe(true);
    expect(crossesMidnight('08:00', '16:00')).toBe(false);
  });

  it('calcule une duree positive a cheval sur deux jours', () => {
    expect(shiftDurationMinutes('22:00', '06:00')).toBe(8 * 60);
    expect(shiftDurationMinutes('08:00', '16:00')).toBe(8 * 60);
    expect(shiftDurationMinutes('21:30', '05:45')).toBe(8 * 60 + 15);
  });
});

describe('minutesOfDay', () => {
  it('convertit en minutes depuis minuit', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('08:30')).toBe(510);
    expect(minutesOfDay('23:59')).toBe(1439);
  });
});

describe('startOfWeekISO', () => {
  it('remonte au lundi', () => {
    // 2026-09-12 est un samedi.
    expect(startOfWeekISO('2026-09-12', 1)).toBe('2026-09-07');
  });

  it('remonte au dimanche quand la semaine y commence', () => {
    expect(startOfWeekISO('2026-09-12', 0)).toBe('2026-09-06');
  });

  it('est stable un jour qui est deja le debut de semaine', () => {
    expect(startOfWeekISO('2026-09-07', 1)).toBe('2026-09-07');
  });
});

describe('bornes de mois', () => {
  it('trouve le dernier jour, fevrier compris', () => {
    expect(endOfMonthISO('2026-09-12')).toBe('2026-09-30');
    expect(endOfMonthISO('2026-02-01')).toBe('2026-02-28');
    expect(endOfMonthISO('2028-02-01')).toBe('2028-02-29');
  });

  it('ne deborde pas en changeant de mois depuis un 31', () => {
    // Naivement, "31 janvier + 1 mois" donne le 3 mars : on ancre donc le
    // calcul sur le premier jour du mois.
    expect(addMonthsISO('2026-01-31', 1)).toBe('2026-02-01');
    expect(addMonthsISO('2026-12-15', 1)).toBe('2027-01-01');
    expect(addMonthsISO('2026-01-15', -1)).toBe('2025-12-01');
  });
});

describe('parseISODate', () => {
  it('renvoie minuit local', () => {
    const date = parseISODate('2026-09-12');
    expect(date?.getHours()).toBe(0);
    expect(date?.getDate()).toBe(12);
    expect(date?.getMonth()).toBe(8);
  });

  it('renvoie null sur une chaine malformee', () => {
    expect(parseISODate('pas-une-date')).toBeNull();
  });
});
