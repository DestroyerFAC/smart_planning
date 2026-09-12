/**
 * Construction du prompt d'extraction.
 *
 * Le prompt est en francais parce que les documents vises le sont : les codes
 * de poste ("RH", "CP", "AM"), les abreviations de jours et les intitules de
 * colonnes sont francais, et demander au modele de raisonner dans la langue du
 * document reduit nettement les contresens.
 */

/** Contrat de sortie, repete au modele a chaque appel. */
const OUTPUT_CONTRACT = `{
  "rangeStart": "AAAA-MM-JJ",
  "rangeEnd": "AAAA-MM-JJ",
  "people": [
    {
      "name": "NOM Prenom exactement comme ecrit sur le document",
      "entries": [
        {
          "date": "AAAA-MM-JJ",
          "start": "HH:MM ou null",
          "end": "HH:MM ou null",
          "label": "texte brut lu dans la case",
          "kind": "work | rest | leave | sick | training | unknown",
          "note": "precision utile ou null",
          "confidence": 0.0
        }
      ]
    }
  ],
  "warnings": ["difficulte de lecture rencontree"]
}`;

/** Codes rencontres sur les plannings francais, donnes comme aide a la lecture. */
const CODE_HINTS = `Codes frequents sur les plannings francais :
- M, Mat, Matin -> poste du matin (souvent 06:00-14:00)
- AM, S, Soir, Apres-midi -> poste d'apres-midi (souvent 14:00-22:00)
- N, Nuit -> poste de nuit (souvent 22:00-06:00, se termine le lendemain)
- J, Jour, JO -> journee (souvent 08:00-16:00 ou 09:00-17:00)
- R, RH, Repos, OFF -> repos (kind = "rest", pas d'horaires)
- CP, CA, Conges -> conges payes (kind = "leave")
- RTT, RC -> recuperation (kind = "leave")
- MAL, AM (si colonne absence), Arret -> maladie (kind = "sick")
- FOR, F, Formation -> formation (kind = "training")
- JF, Ferie -> jour ferie (kind = "rest")`;

export interface PromptContext {
  /** Date du jour, pour resoudre une annee absente du document. */
  readonly todayISO: string;
  /** Numero de page, quand le document en compte plusieurs. */
  readonly pageNumber: number;
  readonly pageCount: number;
  /** Noms deja connus : aide le modele a reprendre la meme graphie. */
  readonly knownNames: readonly string[];
}

export function buildSystemPrompt(): string {
  return [
    "Tu es un moteur d'extraction de plannings de travail.",
    "Tu recois la photo ou le scan d'un planning d'equipe et tu renvoies UNIQUEMENT un objet JSON valide, sans texte autour, sans bloc de code markdown.",
    '',
    'Structure exacte attendue :',
    OUTPUT_CONTRACT,
    '',
    'REGLES IMPERATIVES :',
    "1. N'invente jamais une personne, une date ou un horaire. Si une case est illisible, mets kind=\"unknown\", confidence basse, et ajoute un warning.",
    '2. Traite TOUTES les personnes visibles, pas seulement les premieres. Parcours le tableau ligne par ligne jusqu\'en bas.',
    '3. Les dates doivent etre au format AAAA-MM-JJ. Si l\'annee n\'est pas ecrite sur le document, deduis-la du contexte fourni.',
    '4. Les heures sont en 24h au format HH:MM. "8h" devient "08:00", "8h30" devient "08:30".',
    '5. Une case de repos ou d\'absence n\'a pas d\'horaires : start et end valent null.',
    '6. Un poste de nuit qui se termine le lendemain garde son heure de fin telle quelle ("22:00" -> "06:00"), sans changer de date.',
    '7. Le champ label contient le texte BRUT de la case, meme si c\'est un simple code comme "M" ou "RH".',
    '8. confidence est un nombre entre 0 et 1 refletant ta certitude de lecture pour CETTE case.',
    '',
    CODE_HINTS,
  ].join('\n');
}

export function buildUserPrompt(context: PromptContext): string {
  const lines: string[] = [
    `Date du jour : ${context.todayISO}. Utilise-la pour determiner l'annee si le document ne l'indique pas (choisis l'annee qui rend le planning le plus proche de cette date).`,
  ];

  if (context.pageCount > 1) {
    lines.push(
      `Ceci est la page ${context.pageNumber} sur ${context.pageCount} d'un meme document. Extrais uniquement ce qui est visible sur cette page.`,
    );
  }

  if (context.knownNames.length > 0) {
    lines.push(
      '',
      "Personnes deja enregistrees dans l'application. Si tu reconnais l'une d'elles, reprends EXACTEMENT la graphie ci-dessous pour que les plannings se rattachent au bon collegue :",
      context.knownNames.map((name) => `- ${name}`).join('\n'),
    );
  }

  lines.push('', 'Extrais maintenant le planning de cette image. Reponds uniquement par le JSON.');
  return lines.join('\n');
}
