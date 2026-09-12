# Smart Planning

Prends ton planning en photo (ou récupère-le en PDF), il se range tout seul dans
un calendrier — le tien **et celui de tes collègues**. Rephotographie-le plus
tard : les noms et les horaires se mettent à jour automatiquement.

Tout se passe dans le navigateur de ton téléphone. Pas de compte, pas de
serveur, aucune donnée qui part ailleurs.

---

## Ce que ça fait

- **Photo ou PDF → calendrier.** Un modèle de vision lit le tableau, reconnaît
  chaque personne, chaque jour et chaque horaire.
- **Mise à jour, pas duplication.** Un nouvel import remplace le planning sur la
  période couverte : horaires modifiés, postes supprimés, tout suit. L'app
  t'affiche le bilan (ajoutés / modifiés / supprimés) avant que tu partes.
- **Calendrier complet.** Vues mois, semaine (grille horaire) et jour, filtre
  par personne, correction manuelle de n'importe quelle case.
- **Gère les cas pénibles :** postes de nuit à cheval sur deux jours, repos et
  congés, noms écrits différemment d'un mois sur l'autre (`DUPONT Jean`,
  `Jean Dupont`, `J. Dupont` → une seule fiche).
- **Installable** sur l'écran d'accueil, fonctionne hors ligne (sauf l'analyse
  d'une nouvelle photo, qui a besoin du réseau).
- **Export vers le Calendrier iPhone**, ce qui donne un vrai widget d'écran
  d'accueil (voir plus bas).

---

## Mise en route

### 1. Publier l'application

Le dépôt se déploie tout seul sur GitHub Pages : le workflow active Pages
lui-même au premier passage, il n'y a rien à configurer à la main.

Chaque push sur la branche par défaut reconstruit et republie le site. Tu peux
aussi le relancer depuis l'onglet **Actions → Déploiement GitHub Pages → Run
workflow**.

Le site apparaît sur `https://<ton-compte>.github.io/smart_planning/`.

> Si le job échoue sur « Get Pages site failed », c'est que l'activation
> automatique a été refusée : va alors dans **Settings → Pages** et choisis
> **GitHub Actions** comme **Source**, puis relance le workflow.

### 2. Obtenir une clé Groq

1. Va sur **console.groq.com/keys**, crée un compte, génère une clé
   (elle commence par `gsk_`).
2. Dans l'app : **⚙ Réglages → IA**, colle la clé, touche **Tester la clé**.

La clé reste dans le stockage de ton navigateur et n'est envoyée qu'à Groq.
Elle n'est ni dans le code, ni sur GitHub.

### 3. Installer sur l'iPhone

Ouvre le site **dans Safari** (pas Chrome — iOS réserve l'installation à
Safari), puis **Partager → Sur l'écran d'accueil**.

### 4. Importer un planning

Bouton **+** → **Prendre une photo** ou **Choisir un fichier**.

Pour un bon résultat : cadre le tableau seul, à plat, sans reflet, en tenant le
téléphone parallèle à la feuille.

### 5. Dire qui tu es

Onglet **Collègues** → touche ton nom → **C'est moi**. Ça débloque le filtre
« Moi » et l'export de ton seul planning.

---

## Le widget sur l'écran d'accueil

**À dire franchement : une application web ne peut pas créer son propre widget
iOS.** Apple n'ouvre WidgetKit qu'aux applications natives installées depuis
l'App Store. Aucun site, quel qu'il soit, ne peut contourner ça.

Le chemin qui marche vraiment passe par le Calendrier d'Apple :

1. **Réglages → Calendrier iPhone → Exporter vers le Calendrier (.ics)**
2. iOS ouvre le fichier → **Ajouter tout** → choisis un calendrier dédié
   (crée-en un nommé « Planning » la première fois).
3. Écran d'accueil → appui long → **+** → widget **Calendrier**.

Tu as alors ton planning sur l'écran d'accueil, dans un vrai widget natif.

> Après un nouvel import, réexporte. iOS **ajoute** les événements sans
> remplacer les anciens : supprime d'abord le calendrier « Planning » dans
> l'app Calendrier pour éviter les doublons. C'est la raison d'être du
> calendrier dédié.

Si tu veux un jour un widget vraiment sur mesure, il faudra une application
native (Swift/SwiftUI, ou React Native avec une extension WidgetKit) — c'est un
autre projet, qui suppose un Mac ou un service de build.

---

## Développement

```bash
npm install
npm run dev        # http://localhost:5173/smart_planning/
npm run build      # vérification des types puis build de production
npm run preview    # sert le build tel qu'il sera en ligne
```

Pour un hébergement à la racine d'un domaine : `APP_BASE=/ npm run build`.

### Organisation du code

```
src/
  types.ts          Modèle de données + type Result (pas d'exceptions qui fuient)
  lib/              Dates/heures locales, hachage déterministe
  db/               Schéma IndexedDB et accès aux données (seule couche qui écrit)
  ai/               Client Groq, prompt d'extraction, validation Zod de la réponse
  ingest/           Fichier → images → extraction → réconciliation
  export/           Génération iCalendar (RFC 5545)
  ui/               Vues calendrier, dialogues, état applicatif
scripts/
  make-icons.py     Génère les icônes PWA (PNG écrit à la main, zéro dépendance)
```

### Deux décisions structurantes

**Identifiants déterministes.** Un poste est identifié par un hachage de
`(personne, date, début, fin)`. Réimporter deux fois la même photo produit les
mêmes identifiants, donc l'écriture écrase au lieu de dupliquer : la
réconciliation est idempotente par construction.

**Dates civiles, jamais d'instants UTC.** Un planning est une heure murale :
un poste à 08:00 commence à 08:00, quel que soit le fuseau du téléphone. Le
code manipule des chaînes `"2026-09-12"` et `"08:30"` et n'utilise jamais
`toISOString()`, ce qui élimine d'emblée les décalages d'un jour au changement
d'heure.

---

## Limites connues

- **Les données vivent dans ce navigateur.** Effacer les données de Safari les
  supprime. **Réglages → Données → Télécharger une sauvegarde** régulièrement.
- **La qualité d'extraction dépend de la photo.** Les cases lues avec doute
  sont signalées par ⚠️ dans la vue Jour ; corrige-les d'un tap.
- **Annuler un import** retire les postes qu'il a créés, mais ne restaure pas
  ceux qu'il avait écrasés. Réimporter le document précédent les rétablit.
- **PDF : 8 premières pages** analysées, une requête par page.
- **Appel direct depuis le navigateur.** Si Groq refuse les requêtes
  navigateur (erreur CORS), l'app le dit et un champ **URL de proxy** est prévu
  dans les réglages avancés.
- **Une clé API dans un navigateur reste une clé dans un navigateur.** Elle est
  isolée par origine, mais si tu partages l'application avec d'autres
  personnes, donne à chacune sa propre clé plutôt que la tienne.
