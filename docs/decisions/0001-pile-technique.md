# ADR 0001 — Pile technique et outillage

Statut : accepté · 9 novembre 2026 · tâches 0.1, 0.2 et 0.3

## Contexte

Le PRD (section 24) fixe un jeu web en TypeScript, rendu par PixiJS, avec une simulation dans un Web Worker. Le plan (section 3) propose les bibliothèques. Il restait à choisir les versions, la configuration et les garde-fous, ce qu'a fait la tâche 0.1.

## Décision

| Sujet | Choix |
|---|---|
| Build | Vite 8, qui regroupe le code avec rolldown. |
| Langage | TypeScript 6.0 en mode strict, et non la version 7 : typescript-eslint ne l'accepte pas encore. Seule la syntaxe effaçable est admise (`erasableSyntaxOnly`) : ni `enum`, ni `namespace`. `noUncheckedIndexedAccess` reste désactivé, car il typerait chaque lecture d'un tableau typé en `number \| undefined`. |
| Rendu et interface | PixiJS 8 ; Preact 10 et `@preact/signals`, le JSX étant transformé par Vite. Preact 11, sorti cinq semaines plus tôt, attendra une tâche dédiée. |
| Données | Zod 4. |
| Qualité | ESLint 10 avec les règles strictes et typées de typescript-eslint, Prettier, Vitest 5. |
| Node | `engines` admet Node 22.13 et plus (22, 24, 26) ; l'intégration continue tourne sous Node 26, la LTS active (`.nvmrc`). `@types/node` suit la version minimale admise, 22.13. |
| Intégration continue | GitHub Actions : lint, types, tests, build et `npm audit --audit-level=high` sur chaque PR et chaque fusion sur `main`, qui déploie ensuite sur GitHub Pages. Les actions sont épinglées par leur commit. Le build emploie des chemins relatifs (`base: './'`) : il sert tel quel en local comme sous `/PixelCiv/`. |

Le code est vérifié par trois programmes TypeScript :
- `tsconfig.worker.json` : le code exécuté dans le worker ou partagé avec lui, avec la bibliothèque WebWorker, où le DOM est une erreur ;
- `tsconfig.app.json` : le reste de `src`, avec la bibliothèque DOM ;
- `tsconfig.node.json` : `vite.config.ts` et `tools/`, avec les types de Node.

Les tests sont typés avec le code qu'ils testent. Les imports relatifs s'écrivent sans extension et se résolvent comme sous Vite ; les outils de `tools/` passent par Vitest ou par Vite. Ce choix sera revu le jour où un outil devra tourner directement sous Node.

Garde-fous :
- ESLint traduit en règles les consignes de déterminisme et d'isolement du worker (ADR 0003 et 0004). `tools/eslint-config.test.ts` vérifie ces règles.
- Les dépendances sont installées dans des versions publiées depuis au moins deux semaines (`npm install --before=<date>`), par prudence face aux paquets compromis ; le fichier de verrouillage les épingle.
- Toute dépendance doit être sous une licence permissive, compatible avec une sortie commerciale (AST-05), qu'elle soit distribuée ou non. `tools/licenses.test.ts` le vérifie sur le fichier de verrouillage. Seuls quelques outils de build, nommés un à un et dont le code n'est pas distribué, y échappent. Au build, `tools/bundle-licenses.ts` refuse en outre tout paquet du bundle, du fil principal comme du worker, sous une licence non admise, sans exception d'outil.

## Conséquences

- `npm run typecheck` enchaîne les trois programmes : un module du worker qui touche au DOM ne compile pas.
- Passer à TypeScript 7 ou à Preact 11 demandera une tâche dédiée, quand l'outillage suivra.
- Une nouvelle dépendance se choisit avec sa licence : un paquet sous licence non admise fait échouer les tests.
