# Crédits

Ce fichier recense ce que PixelCiv doit à d'autres : sprites, bibliothèques, algorithmes. Chaque élément y est consigné dès son intégration (AST-02), et l'écran des crédits du jeu en reprendra le contenu (IHM-08).

Le code et le contenu propres au jeu restent sous droits réservés : le dépôt n'a pas de fichier de licence (PLAN, section 2).

## Pack de sprites

Pas intégré. Le pack retenu par l'auteur est la version gratuite de « 2D Pixel Art Male and Female Character », de GandalfHardcore : <https://gandalfhardcore.itch.io/2d-pixel-art-male-and-female-character> (PRD, question 14). Sa licence reste à vérifier avant tout versement (AST-01, AST-02), et les mini-sprites de la carte, de 6 à 10 px de haut, seront de toute façon générés (REN-04, phase 2). On consignera ici sa licence s'il est intégré.

| Auteur | Lien | Licence | Emplacement |
|---|---|---|---|
| GandalfHardcore | [itch.io](https://gandalfhardcore.itch.io/2d-pixel-art-male-and-female-character) | à vérifier | non versé : `assets/source/` si la licence permet de redistribuer les fichiers, sinon `assets/local/`, hors du dépôt |

`assets/source/README.md` décrit la marche à suivre.

## Bibliothèques distribuées avec le jeu

Ces bibliothèques font partie du jeu publié. Le build échoue si l'une d'elles manque ici ou si sa licence n'est pas admise, et il joint au jeu leurs textes de licence, dans `licenses.txt` (`tools/bundle-licenses.ts`, ADR 0008).

| Bibliothèque | Rôle | Auteurs | Licence | Lien |
|---|---|---|---|---|
| `pixi.js` | Rendu de la carte | Mathew Groves, Chad Engler et l'équipe PixiJS | MIT | https://pixijs.com |
| `preact` | Interface | Jason Miller et l'équipe Preact | MIT | https://preactjs.com |
| `@preact/signals` et `@preact/signals-core` | État de l'interface | L'équipe Preact | MIT | https://github.com/preactjs/signals |
| `zod` | Validation des données et des sauvegardes | Colin McDonnell | MIT | https://zod.dev |

PixiJS inclut à son tour :

| Bibliothèque | Rôle | Auteurs | Licence | Lien |
|---|---|---|---|---|
| `@pixi/colord` | Couleurs, d'après colord | Vlad Shilov | MIT | https://github.com/omgovich/colord |
| `earcut` | Triangulation des polygones | Volodymyr Agafonkin, Mapbox | ISC | https://github.com/mapbox/earcut |
| `eventemitter3` | Événements | Arnout Kazemier | MIT | https://github.com/primus/eventemitter3 |
| `ismobilejs` | Détection des appareils mobiles | Kai Mallea | MIT | https://github.com/kaimallea/isMobile |
| `parse-svg-path` | Lecture des tracés SVG | Jake Rosoman | MIT | https://github.com/jkroso/parse-svg-path |

## Algorithmes

Ces algorithmes ont été réécrits à partir de leur description publiée, sans reprise de code.

| Algorithme | Usage | Auteurs | Référence |
|---|---|---|---|
| xoshiro128** | Générateur pseudo-aléatoire (`src/core/rng.ts`) | David Blackman et Sebastiano Vigna | https://prng.di.unimi.it |
| SplitMix et finaliseur de MurmurHash3 | Graines des flux du générateur (`src/core/rng.ts`) | Guy L. Steele Jr., Doug Lea et Christine H. Flood ; Austin Appleby | « Fast Splittable Pseudorandom Number Generators », OOPSLA 2014 ; https://github.com/aappleby/smhasher |
| FNV-1a | Empreintes de l'état (`src/core/hash.ts`) | Glenn Fowler, Landon Curt Noll et Kiem-Phong Vo | http://www.isthe.com/chongo/tech/comp/fnv/ |
| Réduction d'argument de Cody et Waite | Fonctions trigonométriques déterministes (`src/core/dmath.ts`) | William J. Cody et William Waite | *Software Manual for the Elementary Functions*, Prentice-Hall, 1980 |

## Outils de développement

Ils servent à construire et à vérifier le jeu, mais ne sont pas distribués avec lui : Vite et Rolldown (MIT), TypeScript (Apache-2.0), ESLint et typescript-eslint (MIT), Prettier (MIT), Vitest (MIT). Lightning CSS (MPL-2.0) transforme les feuilles de style au build ; seul ce qu'il produit est distribué, ce qu'admet l'exception d'outil de l'ADR 0001.
