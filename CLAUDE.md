# CLAUDE.md

Jeu de simulation de mondes et de vies en pixel art, à la croisée de WorldBox, Crusader Kings et BitLife.

- Ce que le jeu doit faire : `docs/PRD.md`.
- Comment le construire, et dans quel ordre : `docs/PLAN.md`.
- Décisions d'architecture : `docs/decisions/`.
- Conception détaillée : `docs/design/`.
- Tickets de la phase en cours : `docs/BACKLOG.md`.

## Commandes (créées en phase 0)

- `npm run dev` : serveur de développement, accessible depuis un téléphone du réseau local
- `npm test` : tests (Vitest)
- `npm run typecheck` et `npm run lint`
- `npm run format` : mise en forme par Prettier
- `npm run build` : build de production, déployé sur GitHub Pages depuis `main`

## Architecture

- `src/sim/` et `src/worldgen/` s'exécutent dans un Web Worker : aucun accès au DOM, à PixiJS ni à l'heure.
- `src/worker/` héberge la simulation dans le worker : messages, cadence des pas, mesures. C'est le seul code du worker qui lit l'heure, et il ne la transmet jamais à l'état (ADR 0004).
- `src/gen/` contient les générateurs procéduraux (portraits, armoiries, noms…), sous forme de fonctions pures : une graine et des paramètres donnent toujours le même résultat.
- `src/render/` contient le rendu PixiJS, `src/ui/` l'interface Preact, `src/app/` l'orchestration.
- Le fil principal et le worker communiquent par messages typés (`src/core/protocol.ts`), avec des tampons transférés. Pas de `SharedArrayBuffer`.
- `data/` contient tout le contenu du jeu en JSON, validé par des schémas Zod.

## Règles impératives

- **Déterminisme.** Dans `src/sim`, `src/worldgen` et `src/gen`, n'utilise jamais `Math.random`, `Date` ni `performance.now` ; utilise les flux du PRNG (`src/core/rng.ts`). Dans les calculs qui influencent l'état, n'utilise pas `Math.sin`, `Math.cos`, `Math.exp`, `Math.log` ni `Math.pow`, dont les résultats varient selon les navigateurs. Passe par `src/core/dmath.ts`. ESLint fait respecter ces interdits dans `src/core`, `src/sim`, `src/worldgen` et `src/gen` (ADR 0003).
- **Monde cylindrique.** Normalise toute coordonnée x modulo la largeur du monde. Calcule toute distance horizontale par le plus court chemin, y compris à travers la couture est-ouest.
- **Contenu en données.** Ne code en dur aucun contenu de jeu (biomes, espèces, savoirs, biens, titres, événements…) : tout vient de `data/`.
- **Textes.** N'écris en dur aucun texte affiché : passe par `t('clé')` et ajoute la clé dans `src/i18n/fr.json`. Les titres ont une forme masculine et une forme féminine.
- **Performances.** Stocke les individus ordinaires en tableaux typés, une colonne par attribut, sans objet par individu. Seuls les notables ont des objets.
- **Pixel art.** Rends en échantillonnage au plus proche, avec des positions entières à l'écran. Ne mélange jamais deux densités de pixels dans une même vue.
- **Modèle.** Civilisation et culture sont distinctes, en relation libre (plusieurs à plusieurs). Un gouvernement a un type et un mode d'accès au pouvoir, deux attributs indépendants. Chaque case porte un biome naturel et, à part, une occupation du sol (champ, coupe, friche, zone bâtie…).
- **Saisons.** Ne recuis jamais les blocs de carte pour une saison : elles passent par la texture de données et le shader.
- **Qualité.**
  - TypeScript strict, sans `any`.
  - Identifiants en anglais, commentaires et documentation en français.
  - Toute logique de simulation ou de génération a ses tests, dont un test de déterminisme par empreinte de l'état.

## Méthode

- Une tâche correspond à un ticket, une branche et une PR. Fais des PR petites, avec tests, types et lint au vert.
- Consigne toute nouvelle décision d'architecture dans un ADR court, dans `docs/decisions/`.
- `prototypes/` contient des notebooks et scripts Python d'exploration, qui illustrent des idées.
- Avant d'implémenter un système marqué « à concevoir » dans le PRD, vérifie qu'un document existe dans `docs/design/`. S'il n'existe pas, demande avant de coder.
- Le PRD et les documents validés de `docs/design/` (comme `C1-monde.md`) font foi. En cas d'écart avec un prototype, ce sont eux qui l'emportent.
- N'installe que des dépendances publiées depuis au moins deux semaines (`npm install --before=<date>`) et sous licence permissive : les tests et le build le vérifient (ADR 0001).
- Ne verse jamais de secret dans le dépôt, qui est public. N'y verse aucun asset tiers sans licence autorisant sa redistribution.
- Crédite dans `CREDITS.md`, dès son intégration, toute bibliothèque distribuée avec le jeu et tout asset tiers. Le build échoue si une bibliothèque distribuée y manque (ADR 0008).
