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

Le site est publié sur **Cloudflare Workers**, automatiquement à chaque push
sur la branche par défaut.

**Une seule manipulation, à faire une fois :** donner à GitHub le droit de
déployer sur ton compte Cloudflare.

1. Sur **dash.cloudflare.com** → icône de profil → **API Tokens** →
   **Create Token** → modèle **Edit Cloudflare Workers** → **Continue** →
   **Create Token**. Copie le jeton (il n'est affiché qu'une fois).
2. Sur GitHub : **Settings → Secrets and variables → Actions →
   New repository secret**.
   Nom : `CLOUDFLARE_API_TOKEN`, valeur : le jeton copié.
3. **Actions → Déploiement Cloudflare Workers → Run workflow.**

L'URL publique s'affiche dans le résumé du job, sous la forme
`https://smart-planning.<ton-sous-domaine>.workers.dev`.

> Si ton jeton donne accès à plusieurs comptes Cloudflare, ajoute un second
> secret `CLOUDFLARE_ACCOUNT_ID` (visible dans l'URL du tableau de bord).

### Déployer depuis ta machine (optionnel)

```bash
npx wrangler login
npm run deploy
```

### GitHub Pages (solution de repli)

Le workflow **Déploiement GitHub Pages** existe toujours, en déclenchement
manuel. Pour t'en servir : **Settings → Pages → Source : GitHub Actions**,
puis lance-le depuis l'onglet Actions. Il construit avec le sous-chemin
`/smart_planning/` qu'impose Pages.

> Cette activation ne peut pas être automatisée : le jeton d'un workflow a le
> droit de configurer un site Pages, mais pas d'en créer un (l'API répond
> « Resource not accessible by integration »).

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
npm run dev        # http://localhost:5173/
npm run build      # vérification des types, tests, puis build de production
npm run preview    # sert le build tel qu'il sera en ligne
npm run deploy     # build puis publication sur Cloudflare Workers
```

Le site est construit pour la **racine** par défaut, ce qu'attendent Cloudflare
Workers et un domaine personnalisé. GitHub Pages impose un sous-chemin :
`APP_BASE=/smart_planning/ npm run build` (son workflow le fait déjà).

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
wrangler.jsonc      Worker « assets-only » : Cloudflare sert dist/, sans code serveur
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
