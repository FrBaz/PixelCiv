# Crédits

Ce fichier recense ce que PixelCiv doit à d'autres : sprites, bibliothèques, algorithmes. Chaque élément y est consigné dès son intégration (AST-02), et l'écran des crédits du jeu en reprendra le contenu (IHM-08).

Le code et le contenu propres au jeu restent sous droits réservés : le dépôt n'a pas de fichier de licence (PLAN, section 2).

## Pack de sprites

Intégré à la tâche 2b.5 (ADR 0016) : « 2D Pixel Art Male and Female Character », version gratuite, de GandalfHardcore, <https://gandalfhardcore.itch.io/2d-pixel-art-male-and-female-character> (PRD, question 14). L'auteur du jeu a versé ses planches dans `sprites/humans/skin/` et vérifié sa licence le 15 novembre 2026 : elle permet de les modifier, et de les distribuer avec le jeu, comme dans ce dépôt public (`docs/design/corrections-phase-2.md`). Ses termes ne sont pas recopiés ici.

Le jeu part des deux planches de base, `Male Skin1.png` et `Female Skin1.png`. Il en distribue les pixels, recodés au build en rôles de teinte (région du corps et rang du ton), réduits pour les zooms faibles, composés en enfants, et recolorés à l'exécution d'après les palettes de l'auteur du jeu (`tools/human-atlas.ts`, `src/render/humans.ts`) ; les planches elles-mêmes restent dans le dépôt, non publiées avec le jeu. Le jeu publié nomme le pack dans `licenses.txt`, jusqu'à l'écran des crédits (IHM-08).

| Titre | Auteur | Lien | Licence | Emplacement |
|---|---|---|---|---|
| 2D Pixel Art Male and Female Character (version gratuite) | GandalfHardcore | [itch.io](https://gandalfhardcore.itch.io/2d-pixel-art-male-and-female-character) | vérifiée par l'auteur du jeu le 15 novembre 2026 : modification et distribution avec le jeu permises | `sprites/humans/skin/` |

Les palettes de peau, de cheveux et de tissus que le jeu pose sur ces planches sont celles de l'auteur du jeu (`sprites/sprite_converter.ipynb`, et Portrait64), sous la licence du dépôt. Les mini-sprites de la tâche 2.9 ne servent plus (ADR 0016) ; les bannières des groupes restent dessinées pour le jeu (`assets/pixel/icons/`).

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
| SplitMix et finaliseur de MurmurHash3 | Graines des flux du générateur (`src/core/rng.ts`) et des noms de chaque langue (`src/gen/names.ts`) ; déphasage de la marche de chaque individu sur la carte (`src/render/crowd.ts`) ; tirages de la pose du décor, case par case (`src/gen/decor.ts`) | Guy L. Steele Jr., Doug Lea et Christine H. Flood ; Austin Appleby | « Fast Splittable Pseudorandom Number Generators », OOPSLA 2014 ; https://github.com/aappleby/smhasher |
| FNV-1a | Empreintes de l'état (`src/core/hash.ts`) ; variante de chaque portrait, tirée du génome (`src/ui/Portrait.tsx`) ; empreintes des planches habillées et de l'atlas des humains, dans leurs tests (`src/render/humans.test.ts`, `tools/human-atlas.test.ts`) ; empreintes de la pose et de l'atlas du décor, dans leurs tests (`src/gen/decor.test.ts`, `tools/decor-atlas.test.ts`) | Glenn Fowler, Landon Curt Noll et Kiem-Phong Vo | http://www.isthe.com/chongo/tech/comp/fnv/ |
| Espace de couleurs OKLab | Contraste des tissus et des peaux, dans son test (`tools/author-palettes.test.ts`) | Björn Ottosson | « A perceptual color space for image processing », 2020, https://bottosson.github.io/posts/oklab/ |
| Réduction d'argument de Cody et Waite | Fonctions trigonométriques déterministes (`src/core/dmath.ts`) | William J. Cody et William Waite | *Software Manual for the Elementary Functions*, Prentice-Hall, 1980 |
| Bruit simplex | Relief, climat, flore et gisements (`src/core/noise.ts`), au noyau resserré à √0,5 | Ken Perlin ; forme et code de Stefan Gustavson (domaine public) | Ken Perlin, « Noise hardware », SIGGRAPH 2001 ; Stefan Gustavson, « Simplex noise demystified », 2005 |
| Bruit de crêtes | Chaînes de montagnes (`src/worldgen/sampler.ts`) | F. Kenton Musgrave | *Texturing and Modeling: A Procedural Approach*, Academic Press, 1994 |
| Priority-Flood, variante epsilon | Comblement des dépressions et écoulement (`src/worldgen/hydrology.ts`) | Richard Barnes, Clarence Lehman et David Mulla | « Priority-Flood: An optimal depression-filling and watershed-labeling algorithm for digital elevation models », *Computers & Geosciences* 62, 2014 |
| Algorithme de Dial | Champs de distance (`src/worldgen/grid.ts`) | Robert B. Dial | « Algorithm 360: Shortest-path forest with topological ordering », *Communications of the ACM* 12, 1969 |
| Formule de Turc et Pike | Évapotranspiration et ruissellement (`src/worldgen/hydrology.ts`) | Lucien Turc ; J. G. Pike | L. Turc, « Le bilan d'eau des sols », *Annales agronomiques*, 1954 ; J. G. Pike, « The estimation of annual run-off from meteorological data in a tropical climate », *Journal of Hydrology* 2, 1964 |
| Seuil d'aridité de Köppen | Climats secs du classement des biomes (`data/worldgen.json`) | Wladimir Köppen | « Das geographische System der Klimate », *Handbuch der Klimatologie*, 1936 |
| Mortalité de Siler | Risque de mort selon l'âge, pour chaque espèce (`src/sim/lifecycle.ts` ; paramètres dans `data/species.json`, décrits par `src/core/data/people.ts`) | William Siler | « A competing-risk model for animal mortality », *Ecology* 60, 1979 |
| Transformation de Box et Muller | Tirages gaussiens des traits continus, à l'apparition comme à l'hérédité (`src/sim/genetics.ts`) | George E. P. Box et Mervin E. Muller | « A Note on the Generation of Random Normal Deviates », *The Annals of Mathematical Statistics* 29, 1958 |
| Tramage ordonné de Bayer | Couverture de neige et de glace, et calme de la mer animée avant le gel, sans sortir des palettes (`src/render/bake.ts`, `src/render/mapShader.ts`, `src/render/waves.ts`) ; ton du sol sous l'ombre portée du décor, neige comprise (`src/render/humanShader.ts`) | Bryce E. Bayer | « An optimum method for two-level rendition of continuous-tone pictures », IEEE International Conference on Communications, 1973 |

## Outils de développement

Ils servent à construire et à vérifier le jeu, mais ne sont pas distribués avec lui : Vite et Rolldown (MIT), TypeScript (Apache-2.0), ESLint et typescript-eslint (MIT), Prettier (MIT), Vitest (MIT). Lightning CSS (MPL-2.0) transforme les feuilles de style au build ; seul ce qu'il produit est distribué, ce qu'admet l'exception d'outil de l'ADR 0001.
