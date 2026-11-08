# Backlog

Les tickets du projet sont tenus ici tant que la CLI `gh` n'est pas disponible dans les sessions de Claude Code (PLAN, section 12). On pourra les reporter en tickets GitHub, rattachés au jalon de leur phase.

Chaque ticket donne lieu à une branche et à une PR (CLAUDE.md, section « Méthode »). Les phases suivantes seront détaillées ici à leur ouverture.

États possibles : à faire, en cours, à relire, fait.

## Phase 0 — Socle technique

Objectif : un projet outillé, testé et déployé automatiquement, avec l'architecture en place (fil principal, worker, protocole, temps, caméra, traduction, données, sauvegarde), avant tout contenu de jeu.

**Jalon 0.** Sur PC et sur téléphone, une grille de test qui boucle d'est en ouest, zoomable, avec contrôle du temps, panneau de débogage et sauvegarde.

| # | Tâche | Exigences | Critère d'acceptation | État |
|---|---|---|---|---|
| 0.1 | Projet Vite et TypeScript strict, arborescence, ESLint, Prettier, Vitest ; scripts `dev`, `build`, `test`, `typecheck`, `lint` ; licences des dépendances vérifiées. | NF-11, AST-05 | `npm test` et `npm run build` passent. | à relire |
| 0.2 | Documentation : PRD et plan dans `docs/` ; premiers ADR (pile technique, monde cylindrique, déterminisme, communication avec le worker) ; relecture de `CLAUDE.md`. | — | ADR rédigés et cités dans le plan. | à faire |
| 0.3 | Intégration continue GitHub Actions (lint, types, tests, build) et déploiement sur GitHub Pages à chaque fusion sur `main`. | — | Chaque PR affiche ses vérifications ; `main` est en ligne. | à faire |
| 0.4 | Squelette d'application : page plein écran, canvas PixiJS, couche d'interface Preact, redimensionnement, orientation, zones de sécurité des téléphones. | IHM-06, IHM-07 | Affichage correct en paysage et en portrait. | à faire |
| 0.5 | Worker de simulation et protocole de messages typé : commandes, instantanés, deltas, tampons transférés. Une seule simulation pour tous les modes. | NF-02, MOD-01 | Un pas factice de 200 ms ne fait pas chuter l'affichage. | à faire |
| 0.6 | Boucle de temps : pas mensuel, calendrier, pause, plusieurs vitesses, horodatage des commandes. | MOD-06 | Une année dure environ 10 s en vitesse normale. | à faire |
| 0.7 | PRNG à flux nommés et maths déterministes (`src/core/rng.ts`, `src/core/dmath.ts`). | NF-09 | Même graine, même suite, sous Node comme dans les navigateurs. | à faire |
| 0.8 | Caméra : déplacement et zoom à la souris, au clavier et au doigt, sur une grille de test qui boucle d'est en ouest. | MON-01, IHM-07 | Défilement sans fin, sans saut à la couture. | à faire |
| 0.9 | Traduction : clés, fichier français, pluriels et genre ; un test échoue si une clé manque. | NF-06, POL-04 | Aucun texte en dur dans le squelette. | à faire |
| 0.10 | Données : chargement et validation par schémas ; premier fichier `data/biomes.json` (biomes du prototype) ; validation en intégration continue. | NF-07, MON-10 | Une donnée invalide fait échouer l'intégration continue. | à faire |
| 0.11 | Sauvegarde minimale : IndexedDB, format versionné, export et import de fichier. | NF-05 | Une partie factice survit à un rechargement et passe d'un appareil à l'autre. | à faire |
| 0.12 | Panneau de débogage : images par seconde, durée des pas, mémoire. | NF-01 | Visible sur PC et téléphone. | à faire |
| 0.13 | Prototypes dans `prototypes/`, pack de sprites dans `assets/source/` si sa licence le permet, fichier `CREDITS.md`. | AST-01, AST-02 | Crédits renseignés. | à faire |

### Notes

- **0.2.** Le PRD et le plan sont déjà dans `docs/`. L'ADR sur la pile technique consigne aussi les choix d'outillage de la tâche 0.1 :
  - TypeScript 6.0, car typescript-eslint n'accepte pas encore la version 7 ;
  - trois programmes TypeScript : le code du worker et le code partagé avec lui (`src/core`, `src/sim`, `src/worldgen`, `src/gen`), typés avec la bibliothèque WebWorker ; le reste de `src`, avec celle du DOM ; la configuration de Vite et `tools/`, avec les types de Node. Les tests sont typés avec le code qu'ils testent ;
  - des règles ESLint de déterminisme et de frontières pour le code du worker, vérifiées par `tools/eslint-config.test.ts` ;
  - des dépendances installées dans des versions publiées depuis au moins deux semaines (`npm install --before=<date>`), et `@types/node` aligné sur la version minimale de Node admise par `engines` ;
  - la vérification des licences par un test (`tools/licenses.test.ts`) : une licence permissive pour tout paquet, distribué ou non, sauf quelques outils de build nommés un à un.

  Reste à trancher, avec le premier outil lancé directement par Node : la convention d'import (extension `.ts` ou non) et le lanceur des outils (Node ou Vitest).
- **0.3.** Il faut activer GitHub Pages, avec « GitHub Actions » comme source (PLAN, section 12, étape 2). Restent à régler :
  - le chemin du site, `/PixelCiv/`, dans l'option `base` de `vite.config.ts` ;
  - la version de Node de l'intégration continue, dans un fichier `.nvmrc` : de préférence la 26, LTS active depuis le 28 octobre 2026. La 24 est en maintenance jusqu'en avril 2028, et la 22 arrive en fin de vie le 30 avril 2027 ;
  - un contrôle, après le build, des licences des paquets réellement mis dans le bundle (option `build.license` de Vite), contre la seule liste des licences admises.

  `npm audit` signale par ailleurs une faille modérée de minimatch, corrigée en 11.0.1, alors qu'ESLint et typescript-eslint dépendent encore de minimatch 10. C'est un déni de service par motif glob malveillant, sans conséquence pour des outils qui ne lisent que nos propres motifs. Si l'intégration continue lance `npm audit`, ce sera avec `--audit-level=high`, en attendant que les deux passent à minimatch 11.0.1 ou plus.
- **0.9.** Le titre de la page, dans `index.html`, est encore écrit en dur.
- **0.10.** Les biomes du prototype sont décrits dans `testMap_filtre.ipynb`, qui doit d'abord être versé dans `prototypes/`.
- **0.13.** Il faut les trois notebooks, le pack de sprites original avec sa licence, ainsi que le nom de son auteur et un lien (PRD, question 14).

## À fournir par l'auteur

| Quoi | Pour | Référence |
|---|---|---|
| Notebooks `testMap_filtre.ipynb`, `testArmoiries.ipynb` et `testVisages.ipynb` | 0.10 et 0.13, puis phases 1, 2 et 4 | PLAN, section 12, étape 1 |
| Pack de sprites original et sa licence | 0.13 | AST-01, AST-02 |
| Nom de l'auteur du pack et lien | 0.13 | PRD, question 14 |
| Activation de GitHub Pages, avec « GitHub Actions » comme source | 0.3 | PLAN, section 12, étape 2 |
