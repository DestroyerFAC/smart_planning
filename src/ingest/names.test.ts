/**
 * Tests du rapprochement des noms.
 *
 * Deux erreurs sont possibles, et elles n'ont pas la meme gravite :
 *  - ne pas reconnaitre deux graphies de la meme personne cree un doublon,
 *    genant mais corrigeable en deux taps depuis la vue Collegues ;
 *  - confondre deux personnes differentes melange leurs plannings, ce qui est
 *    silencieux et grave.
 * Le module est donc volontairement conservateur, et c'est ce que ces tests
 * verrouillent.
 */
import { describe, expect, it } from 'vitest';
import {
  colorForPerson,
  findMatchingPerson,
  nameSimilarity,
  nameTokens,
  normalizeName,
  personIdFromName,
  prettiestName,
} from './names';
import type { Person } from '../types';

const person = (id: string, displayName: string): Person => ({
  id,
  displayName,
  normalizedName: normalizeName(displayName),
  color: '#000',
  isMe: false,
  aliases: [displayName],
  createdAt: 1,
  updatedAt: 1,
});

describe('normalizeName', () => {
  it('rend l ordre nom/prenom sans importance', () => {
    expect(normalizeName('DUPONT Jean')).toBe(normalizeName('Jean Dupont'));
  });

  it('ignore accents, casse et ponctuation', () => {
    expect(normalizeName('Jean-Pierre MÜLLER')).toBe(normalizeName('muller jean pierre'));
    expect(normalizeName("O'CONNOR Sean")).toBe(normalizeName('sean o connor'));
  });

  it('ignore les particules', () => {
    expect(normalizeName('Jean de La Fontaine')).toBe('fontaine jean');
  });

  it('produit un identifiant stable', () => {
    expect(personIdFromName('DUPONT Jean')).toBe(personIdFromName('Jean DUPONT'));
    expect(personIdFromName('Jean Dupont')).not.toBe(personIdFromName('Marie Dupont'));
  });
});

describe('nameTokens', () => {
  it('decoupe sur toute ponctuation', () => {
    expect(nameTokens('DUPONT, Jean-Pierre')).toEqual(['dupont', 'jean', 'pierre']);
  });
});

describe('nameSimilarity', () => {
  it('donne 1 pour le meme nom reordonne', () => {
    expect(nameSimilarity('DUPONT Jean', 'Jean Dupont')).toBe(1);
  });

  it('tolere une faute de lecture d une lettre', () => {
    expect(nameSimilarity('Jean Dupont', 'Jean Dupond')).toBeGreaterThan(0.85);
  });

  it('reconnait une initiale', () => {
    expect(nameSimilarity('J. Dupont', 'Jean Dupont')).toBeGreaterThan(0.82);
  });

  it('separe nettement deux personnes differentes', () => {
    expect(nameSimilarity('Jean Dupont', 'Marie Leroy')).toBeLessThan(0.3);
  });

  it('ne confond pas deux membres d une meme famille', () => {
    expect(nameSimilarity('Jean Dupont', 'Marie Dupont')).toBeLessThan(0.82);
  });
});

describe('findMatchingPerson', () => {
  const people = [person('p_1', 'Jean Dupont'), person('p_2', 'Marie Leroy')];

  it('retrouve une graphie differente', () => {
    expect(findMatchingPerson('DUPONT Jean', people)?.person.id).toBe('p_1');
  });

  it('retrouve malgre une faute de lecture', () => {
    expect(findMatchingPerson('Jean Dupond', people)?.person.id).toBe('p_1');
  });

  it('ne rattache pas un inconnu', () => {
    expect(findMatchingPerson('Ali Ben Salah', people)).toBeNull();
  });

  it('prefere creer une fiche plutot que trancher entre deux candidats proches', () => {
    // Deux homonymes en base : rattacher "Dupont" a l'un des deux serait
    // arbitraire, donc on ne rattache rien.
    const ambiguous = [person('p_1', 'Jean Dupont'), person('p_2', 'Jean Dupond')];
    expect(findMatchingPerson('Jean Dupon', ambiguous)).toBeNull();
  });

  it('ne rattache rien a partir d un nom vide', () => {
    expect(findMatchingPerson('   ', people)).toBeNull();
  });
});

describe('prettiestName', () => {
  it('prefere la forme la plus complete', () => {
    expect(prettiestName(['J. Dupont', 'Jean Dupont'])).toBe('Jean Dupont');
  });

  it('adoucit le tout-majuscules', () => {
    expect(prettiestName(['JEAN DUPONT'])).toBe('Jean Dupont');
  });

  it('conserve une casse mixte voulue', () => {
    expect(prettiestName(['DUPONT Jean'])).toBe('DUPONT Jean');
  });

  it('respecte les traits d union et les accents', () => {
    expect(prettiestName(['JEAN-PIERRE MÜLLER'])).toBe('Jean-Pierre Müller');
  });

  it('renvoie une chaine vide sans candidat exploitable', () => {
    expect(prettiestName(['  ', ''])).toBe('');
  });
});

describe('colorForPerson', () => {
  it('donne toujours la meme couleur au meme identifiant', () => {
    expect(colorForPerson('p_1')).toBe(colorForPerson('p_1'));
    expect(colorForPerson('p_1')).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
  });
});
