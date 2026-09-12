/**
 * FNV-1a 32 bits, encode en base36.
 *
 * Choisi plutot que crypto.subtle parce qu'il est SYNCHRONE : les identifiants
 * de `Shift` sont calcules en masse pendant la reconciliation, et une API
 * asynchrone imposerait de propager des Promise dans tout le pipeline pour
 * aucun benefice — il ne s'agit pas d'un usage cryptographique.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash * 16777619 en arithmetique 32 bits, sans depasser la precision des doubles.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

/** Separateur qui ne peut pas apparaitre dans un champ metier (unit separator). */
const FIELD_SEPARATOR = String.fromCharCode(31);
const NULL_MARKER = String.fromCharCode(0);

/** Concatene des champs avec un separateur qui ne peut pas apparaitre dedans. */
export function hashFields(...fields: readonly (string | null)[]): string {
  return fnv1a(fields.map((f) => f ?? NULL_MARKER).join(FIELD_SEPARATOR));
}
