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
| 0.2 | Documentation : PRD et plan dans `docs/` ; premiers ADR (pile technique, monde cylindrique, déterminisme, communication avec le worker) ; relecture de `CLAUDE.md`. | — | ADR rédigés et cités dans le plan. | à relire |
| 0.3 | Intégration continue GitHub Actions (lint, types, tests, build) et déploiement sur GitHub Pages à chaque fusion sur `main`. | — | Chaque PR affiche ses vérifications ; `main` est en ligne. | à relire |
| 0.4 | Squelette d'application : page plein écran, canvas PixiJS, couche d'interface Preact, redimensionnement, orientation, zones de sécurité des téléphones. | IHM-06, IHM-07 | Affichage correct en paysage et en portrait. | à relire |
| 0.5 | Worker de simulation et protocole de messages typé : commandes, instantanés, deltas, tampons transférés. Une seule simulation pour tous les modes. | NF-02, MOD-01 | Un pas factice de 200 ms ne fait pas chuter l'affichage. | à relire |
| 0.6 | Boucle de temps : pas mensuel, calendrier, pause, plusieurs vitesses, horodatage des commandes. | MOD-06 | Une année dure environ 10 s en vitesse normale. | à relire |
| 0.7 | PRNG à flux nommés et maths déterministes (`src/core/rng.ts`, `src/core/dmath.ts`). | NF-09 | Même graine, même suite, sous Node comme dans les navigateurs. | à relire |
| 0.8 | Caméra : déplacement et zoom à la souris, au clavier et au doigt, sur une grille de test qui boucle d'est en ouest. | MON-01, IHM-07 | Défilement sans fin, sans saut à la couture. | à relire |
| 0.9 | Traduction : clés, fichier français, pluriels et genre ; un test échoue si une clé manque. | NF-06, POL-04 | Aucun texte en dur dans le squelette. | à relire |
| 0.10 | Données : chargement et validation par schémas ; premier fichier `data/biomes.json` (biomes du prototype) ; validation en intégration continue. | NF-07, MON-10 | Une donnée invalide fait échouer l'intégration continue. | à relire |
| 0.11 | Sauvegarde minimale : IndexedDB, format versionné, export et import de fichier. | NF-05 | Une partie factice survit à un rechargement et passe d'un appareil à l'autre. | à relire |
| 0.12 | Panneau de débogage : images par seconde, durée des pas, mémoire. | NF-01 | Visible sur PC et téléphone. | à relire |
| 0.13 | Prototypes dans `prototypes/`, pack de sprites dans `assets/source/` si sa licence le permet, fichier `CREDITS.md`. | AST-01, AST-02 | Crédits renseignés. | à relire |

### Notes

- **0.2.** ADR 0001 à 0004 rédigés dans `docs/decisions/` et cités dans le plan (section 3, version 0.4). `CLAUDE.md` relu : renvoi au backlog, commande `format`, dossier `src/worker/`, portée des règles ESLint, règle sur les dépendances. La convention d'import et le lanceur des outils restent à revoir avec le premier outil lancé directement par Node (ADR 0001).
- **0.3.** Fait : `.github/workflows/ci.yml` (lint, types, tests, build, audit, puis déploiement sur GitHub Pages à chaque fusion sur `main`), Node 26 dans `.nvmrc`, chemins relatifs (`base: './'`) et contrôle au build des licences du bundle (`tools/bundle-licenses.ts`). Pour que `main` soit en ligne, il faut activer GitHub Pages avec « GitHub Actions » comme source (PLAN, section 12, étape 2).

  `npm audit` signale une faille modérée de minimatch, corrigée en 11.0.1, alors qu'ESLint et typescript-eslint dépendent encore de minimatch 10. C'est un déni de service par motif glob malveillant, sans conséquence pour des outils qui ne lisent que nos propres motifs : l'intégration continue ne s'arrête qu'aux failles de niveau élevé ou critique, en attendant que les deux passent à minimatch 11.0.1 ou plus.
- **0.4.** Vérifié dans Chromium, en paysage et en portrait, sur PC et sur téléphone émulé : le canvas couvre l'écran à sa densité de pixels, l'interface respecte les zones de sécurité. Preact 10 plutôt que 11, trop récent (ADR 0001).
- **0.5.** Mesuré dans Chromium avec `?stepCost=200`, qui ajoute 200 ms de calcul à chaque pas : 60 images/s, avec ou sans ce coût, et jamais plus de 17 ms entre deux images. Cette mesure précède la carte de 0.8 ; elle a été refaite en 0.12. Le worker est hébergé par `src/worker/`, qui seul lit l'horloge (ADR 0004).
- **0.6.** Mesuré dans Chromium : 12 mois en 10,0 s en vitesse normale et 24 mois en 5 s en vitesse rapide (×4) ; la pause et le pas unique répondent. Les commandes de jeu sont horodatées du pas où elles s'appliquent et journalisées : rejouer le journal redonne la même empreinte. Les contrôles du temps tiennent jusqu'à 320 px de large.
- **0.7.** Les suites du générateur et son empreinte dans l'auto-test ont été recalculées par une implémentation indépendante, en Python ; celles de xoshiro128** pour l'état [1, 2, 3, 4] sont celles de ses auteurs. Face à Math, `dmath` reste à 1 ulp pour exp, à 3 ulp pour log, et à 1 ulp pour sin et cos jusqu'à ±100, puis 2 ulp jusqu'à 1,6 × 10^6, zéros compris. pow est exacte pour les puissances entières de deux et les petites puissances entières d'entiers ; ailleurs, elle reste à 3 × 10^-14 près en relatif pour un résultat entre 10^-30 et 10^30, et à 3 × 10^-13 près des débordements (ADR 0003). La relecture de la phase 0 a corrigé sin et cos près de leurs zéros et au-delà de 1,6 × 10^6, ainsi que pow pour les grands exposants entiers, les sous-normaux et les débordements. L'auto-test recalcule les empreintes dans le navigateur : le panneau de débogage (0.12) en affiche le résultat.
- **0.8.** Vérifié dans Chromium, jeu en pause : après un glissement d'exactement une largeur de monde, l'image revient identique au pixel près ; une ligne qui traverse la couture ne compte aucun pixel de fond. La molette, le pincement à deux doigts (téléphone émulé) et l'appui bref, qui peint la case touchée par une commande de jeu, fonctionnent. Des promeneurs de test, tirés du générateur, animent la grille au fil des mois.
- **0.9.** Traitée avant 0.5, puisque les tâches suivantes affichent du texte. Clés typées depuis `src/i18n/fr.json`, pluriels, genre ; le titre de la page passe par `t()`. Un test échoue si une clé manque ou ne sert plus, et ESLint refuse le texte en dur dans le JSX (ADR 0005).
- **0.10.** Sur ta demande, `data/biomes.json` reprend directement les 32 biomes de C1 (D6), et non ceux du prototype ; un test le confronte à la liste de C1. Les valeurs (fertilité, coûts, densités de flore, palettes) sont une première proposition, à calibrer en phase 1. Les ressources sont des identifiants que `data/resources.json` définira en 1.6 (ADR 0006).
- **0.11.** Vérifié dans Chromium : une case peinte survit au rechargement de la page, par la sauvegarde automatique ; un fichier exporté (922 octets) se réimporte dans un autre profil avec la même partie ; un fichier étranger est refusé avec un message clair. Une partie rechargée se poursuit à l'identique, ce que vérifie un test par empreinte (ADR 0007).
- **0.12.** Le panneau s'ouvre par son bouton, par F3 ou par la touche ², sous Échap. Il affiche les images par seconde et l'image la plus longue de la dernière seconde, la durée moyenne et maximale des 30 derniers pas, la mémoire du tas JavaScript (Chromium seulement), le moteur de rendu et la densité de pixels, la taille du monde, le contenu chargé et le résultat de l'auto-test du déterminisme. Vérifié dans Chromium, sur PC (1280 × 720) et sur téléphone émulé (Pixel 7) : le panneau tient dans l'écran, et la cadence est la même qu'il soit ouvert ou fermé.

  Sans carte graphique, Chromium dessine en logiciel, vers 25 millions de pixels par seconde. La carte plein écran y tourne donc à 25 images/s en 1280 × 720, mais à 60 images/s en 640 × 360. À cette taille, `?stepCost=200` porte bien la durée des pas à 200 ms, sans faire chuter l'affichage (60 images/s, 17 ms au plus entre deux images) : le critère de 0.5 tient toujours.
- **0.13.** `CREDITS.md` crédite les bibliothèques distribuées avec le jeu (auteurs, rôle, licence, lien), les algorithmes repris et les outils de développement ; la place du pack de sprites y est prête. Le build échoue si une bibliothèque distribuée, du fil principal comme du worker, manque aux crédits. Il joint aussi au jeu `licenses.txt`, qui reprend leurs textes de licence, absents du code minifié (ADR 0008). `prototypes/README.md` liste les notebooks et scripts attendus. `assets/source/README.md` décrit la marche à suivre pour le pack, et git ignore `assets/local/`, où irait un pack non redistribuable.

  Restent à verser les fichiers eux-mêmes, que seul l'auteur peut fournir : notebooks, scripts de C1, pack de sprites avec sa licence, nom de son auteur et lien (PRD, question 14). Le tableau ci-dessous les recense.

## À fournir par l'auteur

| Quoi | Pour | Référence |
|---|---|---|
| Notebook `testMap_filtre.ipynb` | 0.10 et 0.13, puis phase 1 | PLAN, section 12, étape 1 |
| Notebooks `testArmoiries.ipynb` et `testVisages.ipynb`, désormais simples illustrations : portraits et armoiries sont conçus à neuf | 0.13 | PLAN, version 0.3 |
| Scripts de la séance C1, dans `prototypes/c1/` : `lacs_cotes_zones_humides.py` et `saisons.py` | 0.13, puis phase 1, dont ils sont l'implémentation de référence | PLAN, sections 6 et 12 (étape 4) |
| Images de la séance C1, dans `docs/design/C1/` : `avant-apres-tropiques.png`, `avant-apres-nord.png`, `saisons-nord.png` et `saisons.gif` ; `C1-monde.md` y renvoie | phase 1 | PLAN, section 12, étape 4 |
| Pack de sprites original et sa licence | 0.13 | AST-01, AST-02 |
| Nom de l'auteur du pack et lien | 0.13 | PRD, question 14 |
| Activation de GitHub Pages, avec « GitHub Actions » comme source | 0.3 | PLAN, section 12, étape 2 |
