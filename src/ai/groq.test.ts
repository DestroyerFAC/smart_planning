/**
 * Tests du classement des modeles.
 *
 * Cette heuristique choisit seule le modele de remplacement quand celui
 * enregistre disparait du catalogue Groq. Deux erreurs possibles :
 *  - retenir un modele incapable de lire une image (audio, garde-fou) : chaque
 *    import echouerait ensuite sans que la cause soit evidente ;
 *  - ne rien retenir du tout : l'application resterait bloquee alors qu'un
 *    modele utilisable existe.
 * Les deux sont verrouillees ici.
 */
import { describe, expect, it } from 'vitest';
import { rankVisionModels } from './groq';

/** Catalogue representatif : modeles vision, texte, audio et garde-fous. */
const CATALOGUE = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-guard-4-12b',
  'whisper-large-v3',
  'distil-whisper-large-v3-en',
  'playai-tts',
  'nomic-embed-text-v1.5',
];

describe('rankVisionModels', () => {
  it('ecarte les modeles qui ne traitent aucune image', () => {
    const ranked = rankVisionModels(CATALOGUE);
    for (const excluded of ['whisper-large-v3', 'distil-whisper-large-v3-en', 'playai-tts', 'nomic-embed-text-v1.5']) {
      expect(ranked).not.toContain(excluded);
    }
  });

  it('ecarte les garde-fous, malgre un nom en llama-4', () => {
    // « llama-guard-4 » contient « llama-4 » : sans exclusion explicite,
    // l'heuristique le classerait parmi les candidats vision.
    expect(rankVisionModels(CATALOGUE)).not.toContain('meta-llama/llama-guard-4-12b');
  });

  it('place le meilleur candidat vision en tete', () => {
    expect(rankVisionModels(CATALOGUE)[0]).toBe('meta-llama/llama-4-maverick-17b-128e-instruct');
  });

  it('respecte l ordre de preference entre familles connues', () => {
    const ranked = rankVisionModels([
      'gemma-3-12b-it',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'some-vision-model',
    ]);
    expect(ranked).toEqual([
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'some-vision-model',
      'gemma-3-12b-it',
    ]);
  });

  it('reconnait des familles vision d autres fournisseurs', () => {
    const ranked = rankVisionModels(['pixtral-12b', 'qwen2.5-vl-7b', 'llava-1.6-34b']);
    expect(ranked).toHaveLength(3);
  });

  it('renvoie les modeles restants quand aucun nom ne trahit la vision', () => {
    // Catalogue entierement renouvele : plutot que de bloquer l'application,
    // on propose ce qui reste et l'utilisateur tranche.
    const ranked = rankVisionModels(['modele-inconnu-b', 'modele-inconnu-a', 'whisper-large-v3']);
    expect(ranked).toEqual(['modele-inconnu-a', 'modele-inconnu-b']);
  });

  it('renvoie une liste vide pour un catalogue vide', () => {
    expect(rankVisionModels([])).toEqual([]);
  });

  it('ne renvoie que des modeles audio ecartes, donc rien, si c est tout ce qu il y a', () => {
    expect(rankVisionModels(['whisper-large-v3', 'playai-tts'])).toEqual([]);
  });

  it('est deterministe', () => {
    expect(rankVisionModels(CATALOGUE)).toEqual(rankVisionModels(CATALOGUE));
  });

  it('ne modifie pas le tableau recu', () => {
    const input = [...CATALOGUE];
    rankVisionModels(input);
    expect(input).toEqual(CATALOGUE);
  });
});
