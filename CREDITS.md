# Crédits

Ce fichier recense ce que PixelCiv doit à d'autres : sprites, bibliothèques, algorithmes. Chaque élément y est consigné dès son intégration (AST-02), et l'écran des crédits du jeu en reprendra le contenu (IHM-08).

Le code et le contenu propres au jeu restent sous droits réservés : le dépôt n'a pas de fichier de licence (PLAN, section 2).

## Pack de sprites

Pas intégré. Le pack retenu par l'auteur est la version gratuite de « 2D Pixel Art Male and Female Character », de GandalfHardcore : <https://gandalfhardcore.itch.io/2d-pixel-art-male-and-female-character> (PRD, question 14). Sa licence reste à vérifier avant tout versement (AST-01, AST-02). Les mini-sprites de la carte n'en dépendent pas : ils sont dessinés pour le jeu, sous la licence du dépôt, en grilles de texte de 6 à 9 px de haut (`assets/pixel/`), et recolorés pour chaque individu (REN-04, REN-09). On consignera ici sa licence s'il est intégré.

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

Ces algorithmes ont été réécrits à partir de leur description publiée, sans reprise de code, sauf le bruit simplex, porté du code de Stefan Gustavson, versé au domaine public.

| Algorithme | Usage | Auteurs | Référence |
|---|---|---|---|
| xoshiro128** | Générateur pseudo-aléatoire (`src/core/rng.ts`) | David Blackman et Sebastiano Vigna | https://prng.di.unimi.it |
| SplitMix et finaliseur de MurmurHash3 | Graines des flux du générateur (`src/core/rng.ts`) et des noms de chaque langue (`src/gen/names.ts`) | Guy L. Steele Jr., Doug Lea et Christine H. Flood ; Austin Appleby | « Fast Splittable Pseudorandom Number Generators », OOPSLA 2014 ; https://github.com/aappleby/smhasher |
| FNV-1a | Empreintes de l'état (`src/core/hash.ts`) ; variante de chaque portrait, tirée du génome (`src/ui/Portrait.tsx`) | Glenn Fowler, Landon Curt Noll et Kiem-Phong Vo | http://www.isthe.com/chongo/tech/comp/fnv/ |
| Réduction d'argument de Cody et Waite | Fonctions trigonométriques déterministes (`src/core/dmath.ts`) | William J. Cody et William Waite | *Software Manual for the Elementary Functions*, Prentice-Hall, 1980 |
| Bruit simplex | Relief, climat, flore et gisements (`src/core/noise.ts`), au noyau resserré à √0,5 | Ken Perlin ; forme et code de Stefan Gustavson (domaine public) | Ken Perlin, « Noise hardware », SIGGRAPH 2001 ; Stefan Gustavson, « Simplex noise demystified », 2005 |
| Bruit de crêtes | Chaînes de montagnes (`src/worldgen/sampler.ts`) | F. Kenton Musgrave | *Texturing and Modeling: A Procedural Approach*, Academic Press, 1994 |
| Priority-Flood, variante epsilon | Comblement des dépressions et écoulement (`src/worldgen/hydrology.ts`) | Richard Barnes, Clarence Lehman et David Mulla | « Priority-Flood: An optimal depression-filling and watershed-labeling algorithm for digital elevation models », *Computers & Geosciences* 62, 2014 |
| Algorithme de Dial | Champs de distance (`src/worldgen/grid.ts`) | Robert B. Dial | « Algorithm 360: Shortest-path forest with topological ordering », *Communications of the ACM* 12, 1969 |
| Formule de Turc et Pike | Évapotranspiration et ruissellement (`src/worldgen/hydrology.ts`) | Lucien Turc ; J. G. Pike | L. Turc, « Le bilan d'eau des sols », *Annales agronomiques*, 1954 ; J. G. Pike, « The estimation of annual run-off from meteorological data in a tropical climate », *Journal of Hydrology* 2, 1964 |
| Seuil d'aridité de Köppen | Climats secs du classement des biomes (`data/worldgen.json`) | Wladimir Köppen | « Das geographische System der Klimate », *Handbuch der Klimatologie*, 1936 |
| Mortalité de Siler | Risque de mort selon l'âge, pour chaque espèce (`src/sim/lifecycle.ts` ; paramètres dans `data/species.json`, décrits par `src/core/data/people.ts`) | William Siler | « A competing-risk model for animal mortality », *Ecology* 60, 1979 |
| Transformation de Box et Muller | Tirages gaussiens des traits continus, à l'apparition comme à l'hérédité (`src/sim/genetics.ts`) | George E. P. Box et Mervin E. Muller | « A Note on the Generation of Random Normal Deviates », *The Annals of Mathematical Statistics* 29, 1958 |
| Tramage ordonné de Bayer | Couverture de neige et de glace, sans sortir des palettes (`src/render/bake.ts`, `src/render/mapShader.ts`) | Bryce E. Bayer | « An optimum method for two-level rendition of continuous-tone pictures », IEEE International Conference on Communications, 1973 |
| Spirale de Vogel | Grappe des mini-sprites autour de leur groupe, à l'angle d'or (`src/render/crowd.ts`) | Helmut Vogel | « A better way to construct the sunflower head », *Mathematical Biosciences* 44, 1979 |

## Outils de développement

Ils servent à construire et à vérifier le jeu, mais ne sont pas distribués avec lui : Vite et Rolldown (MIT), TypeScript (Apache-2.0), ESLint et typescript-eslint (MIT), Prettier (MIT), Vitest (MIT). Lightning CSS (MPL-2.0) transforme les feuilles de style au build ; seul ce qu'il produit est distribué, ce qu'admet l'exception d'outil de l'ADR 0001.
