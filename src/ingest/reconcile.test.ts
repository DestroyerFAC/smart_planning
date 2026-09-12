/**
 * Tests de la reconciliation.
 *
 * C'est la promesse centrale de l'application — "je rephotographie le planning
 * et il se met a jour tout seul" — et c'est aussi la partie qui peut DETRUIRE
 * des donnees si elle se trompe de perimetre. Elle est donc testee de pres.
 */
import { describe, expect, it } from 'vitest';
import { buildImportPlan, resolvePeople, type ImportMeta } from './reconcile';
import { shiftId } from '../db/repo';
import type { CleanExtraction } from '../ai/schema';
import type { Person, Shift } from '../types';

const META: ImportMeta = {
  sourceName: 'planning.jpg',
  sourceKind: 'image',
  pageCount: 1,
  model: 'test',
  rawResponse: '{}',
};

function extraction(
  people: { name: string; entries: { date: string; start?: string | null; end?: string | null; label?: string }[] }[],
  range: [string, string],
): CleanExtraction {
  return {
    rangeStart: range[0],
    rangeEnd: range[1],
    warnings: [],
    people: people.map((person) => ({
      name: person.name,
      entries: person.entries.map((entry) => ({
        date: entry.date,
        start: entry.start ?? null,
        end: entry.end ?? null,
        label: entry.label ?? 'Poste',
        kind: 'work' as const,
        note: null,
        confidence: 0.9,
      })),
    })),
  };
}

function makePerson(id: string, displayName: string, normalizedName: string): Person {
  return {
    id, displayName, normalizedName,
    color: '#000', isMe: false, aliases: [displayName], createdAt: 1, updatedAt: 1,
  };
}

function makeShift(personId: string, date: string, start: string | null, end: string | null, label = 'Poste'): Shift {
  return {
    id: shiftId(personId, date, start, end),
    personId, date, start, end, label,
    kind: 'work', note: null, importId: 'ancien', confidence: 0.9, updatedAt: 1,
  };
}

describe('resolvePeople', () => {
  it('cree une fiche pour chaque nouveau nom', () => {
    const result = resolvePeople(
      extraction([{ name: 'DUPONT Jean', entries: [] }, { name: 'LEROY Marie', entries: [] }], ['2026-09-07', '2026-09-13']),
      [],
    );
    expect(result.toUpsert).toHaveLength(2);
    // La graphie du document est conservee : "NOM Prenom" est la forme
    // courante des plannings francais, et deviner lequel des deux tokens est
    // le nom de famille serait peu fiable ("Ali Ben Salah").
    expect(result.createdNames).toEqual(['DUPONT Jean', 'LEROY Marie']);
  });

  it('adoucit un nom ecrit entierement en majuscules', () => {
    const result = resolvePeople(
      extraction([{ name: 'DUPONT JEAN', entries: [] }], ['2026-09-07', '2026-09-13']),
      [],
    );
    expect(result.createdNames).toEqual(['Dupont Jean']);
  });

  it('rattache une graphie differente a la personne existante', () => {
    const existing = makePerson('p_1', 'Jean Dupont', 'dupont jean');
    const result = resolvePeople(
      extraction([{ name: 'DUPONT Jean', entries: [] }], ['2026-09-07', '2026-09-13']),
      [existing],
    );
    expect(result.mapping.get('DUPONT Jean')?.id).toBe('p_1');
    expect(result.createdNames).toEqual([]);
  });

  it('fait converger deux graphies du meme nom vues dans le meme document', () => {
    const result = resolvePeople(
      extraction([{ name: 'Jean Dupont', entries: [] }, { name: 'DUPONT Jean', entries: [] }], ['2026-09-07', '2026-09-13']),
      [],
    );
    expect(result.toUpsert).toHaveLength(1);
  });

  it('ne confond pas deux personnes distinctes', () => {
    const result = resolvePeople(
      extraction([{ name: 'Jean Dupont', entries: [] }, { name: 'Marie Leroy', entries: [] }], ['2026-09-07', '2026-09-13']),
      [],
    );
    expect(result.toUpsert).toHaveLength(2);
  });
});

describe('buildImportPlan', () => {
  const RANGE: [string, string] = ['2026-09-07', '2026-09-13'];

  it('ajoute les postes d un premier import', () => {
    const data = extraction([{ name: 'Jean Dupont', entries: [{ date: '2026-09-07', start: '08:00', end: '16:00' }] }], RANGE);
    const plan = buildImportPlan(data, resolvePeople(data, []), [], META);

    expect(plan.record.diff).toMatchObject({ added: 1, updated: 0, removed: 0, unchanged: 0 });
    expect(plan.shiftsToPut).toHaveLength(1);
  });

  it('est idempotent : reimporter le meme document ne change rien', () => {
    const data = extraction([{ name: 'Jean Dupont', entries: [{ date: '2026-09-07', start: '08:00', end: '16:00' }] }], RANGE);
    const resolution = resolvePeople(data, []);
    const personId = resolution.mapping.get('Jean Dupont')?.id ?? '';
    const existing = [makeShift(personId, '2026-09-07', '08:00', '16:00')];

    const plan = buildImportPlan(data, resolution, existing, META);

    expect(plan.record.diff).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 1 });
    expect(plan.shiftIdsToDelete).toEqual([]);
  });

  it('compte un horaire modifie comme UNE modification, pas une suppression plus un ajout', () => {
    const data = extraction([{ name: 'Jean Dupont', entries: [{ date: '2026-09-07', start: '10:00', end: '18:00' }] }], RANGE);
    const resolution = resolvePeople(data, []);
    const personId = resolution.mapping.get('Jean Dupont')?.id ?? '';
    const existing = [makeShift(personId, '2026-09-07', '08:00', '16:00')];

    const plan = buildImportPlan(data, resolution, existing, META);

    expect(plan.record.diff).toMatchObject({ added: 0, updated: 1, removed: 0, unchanged: 0 });
    // L'ancien identifiant doit disparaitre, sinon les deux horaires coexistent.
    expect(plan.shiftIdsToDelete).toEqual([existing[0]?.id]);
  });

  it('supprime un poste retire du nouveau planning', () => {
    const data = extraction([{ name: 'Jean Dupont', entries: [{ date: '2026-09-07', start: '08:00', end: '16:00' }] }], RANGE);
    const resolution = resolvePeople(data, []);
    const personId = resolution.mapping.get('Jean Dupont')?.id ?? '';
    const existing = [
      makeShift(personId, '2026-09-07', '08:00', '16:00'),
      makeShift(personId, '2026-09-09', '08:00', '16:00'),
    ];

    const plan = buildImportPlan(data, resolution, existing, META);

    expect(plan.record.diff).toMatchObject({ added: 0, updated: 0, removed: 1, unchanged: 1 });
    expect(plan.shiftIdsToDelete).toEqual([existing[1]?.id]);
  });

  it('ne touche pas un collegue absent du nouveau document', () => {
    const data = extraction([{ name: 'Jean Dupont', entries: [{ date: '2026-09-07', start: '08:00', end: '16:00' }] }], RANGE);
    const resolution = resolvePeople(data, [makePerson('p_marie', 'Marie Leroy', 'leroy marie')]);
    const marieShift = makeShift('p_marie', '2026-09-07', '14:00', '22:00');

    const plan = buildImportPlan(data, resolution, [marieShift], META);

    expect(plan.shiftIdsToDelete).toEqual([]);
    expect(plan.record.diff.removed).toBe(0);
  });

  it('ne touche pas les dates hors de la plage du document', () => {
    const data = extraction([{ name: 'Jean Dupont', entries: [{ date: '2026-09-07', start: '08:00', end: '16:00' }] }], RANGE);
    const resolution = resolvePeople(data, []);
    const personId = resolution.mapping.get('Jean Dupont')?.id ?? '';
    // Poste du mois suivant : hors perimetre, il doit survivre.
    const horsPlage = makeShift(personId, '2026-10-15', '08:00', '16:00');

    const plan = buildImportPlan(data, resolution, [horsPlage], META);

    expect(plan.shiftIdsToDelete).toEqual([]);
  });

  it('elargit la plage aux dates presentes hors des bornes annoncees', () => {
    // Le modele annonce une semaine mais fournit une entree le lundi suivant.
    const data = extraction([{ name: 'Jean Dupont', entries: [{ date: '2026-09-14', start: '08:00', end: '16:00' }] }], RANGE);
    const plan = buildImportPlan(data, resolvePeople(data, []), [], META);

    expect(plan.record.rangeEnd).toBe('2026-09-14');
  });

  it('distingue un poste ajoute d un poste deplace dans la meme journee', () => {
    // Jean garde son poste du matin et gagne un poste du soir.
    const data = extraction([{
      name: 'Jean Dupont',
      entries: [
        { date: '2026-09-07', start: '08:00', end: '16:00' },
        { date: '2026-09-07', start: '18:00', end: '22:00' },
      ],
    }], RANGE);
    const resolution = resolvePeople(data, []);
    const personId = resolution.mapping.get('Jean Dupont')?.id ?? '';
    const existing = [makeShift(personId, '2026-09-07', '08:00', '16:00')];

    const plan = buildImportPlan(data, resolution, existing, META);

    expect(plan.record.diff).toMatchObject({ added: 1, updated: 0, removed: 0, unchanged: 1 });
  });

  it('remplace un poste par un repos sur la journee entiere', () => {
    const data: CleanExtraction = {
      rangeStart: '2026-09-07', rangeEnd: '2026-09-13', warnings: [],
      people: [{
        name: 'Jean Dupont',
        entries: [{ date: '2026-09-07', start: null, end: null, label: 'RH', kind: 'rest', note: null, confidence: 1 }],
      }],
    };
    const resolution = resolvePeople(data, []);
    const personId = resolution.mapping.get('Jean Dupont')?.id ?? '';
    const existing = [makeShift(personId, '2026-09-07', '08:00', '16:00')];

    const plan = buildImportPlan(data, resolution, existing, META);

    expect(plan.record.diff).toMatchObject({ updated: 1, added: 0, removed: 0 });
    expect(plan.shiftsToPut[0]?.kind).toBe('rest');
    expect(plan.shiftsToPut[0]?.start).toBeNull();
  });

  it('rattache tous les postes ecrits au nouvel import, y compris les inchanges', () => {
    const data = extraction([{ name: 'Jean Dupont', entries: [{ date: '2026-09-07', start: '08:00', end: '16:00' }] }], RANGE);
    const resolution = resolvePeople(data, []);
    const personId = resolution.mapping.get('Jean Dupont')?.id ?? '';

    const plan = buildImportPlan(data, resolution, [makeShift(personId, '2026-09-07', '08:00', '16:00')], META);

    // Sans ce rattachement, annuler le dernier import laisserait des postes
    // orphelins rattaches a un import deja supprime.
    expect(plan.shiftsToPut.every((shift) => shift.importId === plan.importId)).toBe(true);
  });
});
