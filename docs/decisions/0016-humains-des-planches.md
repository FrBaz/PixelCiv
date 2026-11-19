# ADR 0016 — Humains tirés des planches

Statut : accepté · 19 novembre 2026 · tâche 2b.5. Conçu sur un prototype hors du dépôt, critiqué, puis réalisé ; les mesures sont celles de la réalisation, dans ce conteneur de quatre cœurs, Chromium rendant en logiciel (SwiftShader) : ses temps de GPU et ses images par seconde ne disent rien d'un vrai appareil. Les interprétations et écarts de la dernière section sont soumis à l'auteur, planches de revue à l'appui.

## Contexte

La consigne de 2b.5 fait foi (`docs/design/corrections-phase-2.md`) : partir des planches de `sprites/humans/skin/`, les habiller par substitution exacte des tons, région par région, en gardant le modelé et le contour d'origine, sans couleur nouvelle, pour toutes les animations, et prévoir des versions réduites pour les zooms faibles. Les tuiles ne changent pas. Le PRD demande des mini-sprites générés de l'individu (REN-04), une seule densité de pixels par vue (REN-08), des palettes par rôles recolorées à l'exécution (REN-09), et une chaîne d'assets éditables rangés en atlas au build (AST-04) ; l'ADR 0014 (§ 6) a annoncé que 2b.5 ajouterait des niveaux de motifs, avec trois variantes de hauteur au plus. 2b.8 choisira l'animation de chaque activité, 2b.9 fera des portraits dont le teint devra s'accorder à celui de la carte.

Ce que montrent les planches, vérifié au pixel près (`tools/human-sheets.test.ts`) :

- quatorze PNG RGBA de 8 bits, non entrelacés, de 800 × 448 pixels, alpha 0 ou 255 : deux bases, `Male Skin1.png` et `Female Skin1.png`, et six teintes par sexe ;
- une grille de cases de 80 × 64 pixels, sept rangées de 5, 8, 8, 4, 4, 6 et 10 images, soit 45 par sexe, les cases au-delà vides ; figures de trois quarts, tournées vers l'ouest, de 41 à 46 pixels de haut debout, pieds sur la dernière rangée de la case, sauf en l'air (saut, chute) et couchées ;
- base masculine, 11 tons : contour `#13131c` ; peau `#fef0e4`, `#f3d0c4`, `#dea99f`, `#b86a6a` (lumière, base, ombre, ombre profonde) ; sous-vêtement `#94afc0`, `#6985a0`, `#4a6082`, `#293757` ; yeux `#27130f` ; et `#ffffff`, qui n'est pas un œil mais le sourire, deux pixels. La base féminine n'a pas `#ffffff` et ajoute `#e65656` (joues), `#f1868e` (lèvres), `#664d46` (un point au milieu du haut), `#ba756a` (paupières closes de la mort) et `#140b0f` (deux pixels de contour de la mort) ;
- chaque planche de teinte est sa base où les quatre tons de peau, et `#e65656`, deviennent la palette `SKIN` correspondante de `sprites/sprite_converter.ipynb`, rang pour rang (`#e65656` prend l'ombre profonde) ; rien d'autre ne change, alpha compris.

## Décision

### 1. Sources et chaîne

- **Le jeu part des deux planches de base et des six palettes de peau**, pas des douze planches, qui n'apportent rien d'autre : `tools/human-sheets.test.ts` le prouve sur les quatorze PNG, par les palettes des données.
- **Au build**, à côté de `tools/pixel-atlas.ts` : `tools/human-atlas.ts`, extension de Vite, lit les deux bases et les grilles de régions, en tire une image de rôles par image d'animation (`src/gen/humans.ts`, fonctions pures), ses réductions et les corps d'enfants, et range le tout dans le module virtuel `virtual:human-atlas`, refait en développement quand une planche, une grille ou une donnée change. Le décodeur PNG est écrit sur `node:zlib` (`tools/png.ts`, 8 bits par canal, RGB ou RGBA, non entrelacé, alpha gardé) ; `tools/wave-control/png.ts` n'en est plus qu'une enveloppe qui rend le RGB. Aucune dépendance nouvelle. Le module du schéma des humains (`src/core/data/humans.ts`) n'importe que zod, si bien que la configuration de Vite le charge sans avertissement.
- **L'atlas du jeu** ne range que les animations montrées (`shown` dans `data/humans.json`, repos et marche jusqu'à 2b.8) : 1 024 × 129 rôles d'un octet, 598 motifs, construits en 0,6 s. Les tests construisent aussi l'atlas de toutes les animations, 1 024 × 348 rôles et 1 430 motifs, en 1,0 s, pour que les sept rangées restent vérifiées et habillées. Le paquet principal passe de 564,7 à 786,2 ko (de 170,7 à 217,1 ko compressés) ; celui du worker de 284,3 à 295,8 ko, qui lit maintenant `data/humans.json` avec le reste du contenu.
- **Ce que le jeu distribue** : les pixels des deux planches de base, recodés en rôles (région et rang, ou ton gardé), réduits, composés en enfants et recolorés ; au niveau de la planche, une recopie exacte des bases, que prouve le test de l'habillage sans tenue (`tools/human-dressing.test.ts`). Les PNG eux-mêmes restent dans `sprites/`, dans le dépôt public, et ne sont pas publiés avec le jeu. Le jeu publié nomme le pack dans `licenses.txt` (`tools/bundle-licenses.ts`), jusqu'à l'écran des crédits (IHM-08).

### 2. Les régions

- **Treize régions, déclarées dans `data/humans.json`** avec leur lettre (`regions`) : cuir chevelu (`scalp`, qui porte les cheveux), visage, cou, épaules, poitrine, ventre, bras (`upper-arm`), avant-bras, main, bassin, cuisse, jambe (`shin`), pied. Le schéma les borne à ce que tiennent les rôles d'un octet ; les tenues ne citent que celles-là (`checkContent`).
- **Masques en grilles de texte**, une par sexe et par animation (`assets/humans/regions/<sexe>/<animation>.txt`, 14 fichiers, 113 624 octets, format dans `assets/humans/README.md`). Le build vérifie chaque pixel des 90 images : transparent sous `.`, ton gardé sous `o`, peau ou sous-vêtement sous une lettre ; une erreur nomme le fichier, l'image et le pixel.
- **Corrigées par rapport au prototype**, d'après les planches en fausses couleurs et les aires des membres : la marche féminine (images 0, 1, 2, 6 et 7, où le bras qui longe le torse était compté en poitrine et en ventre), le lancer féminin (images 1 à 5 : le bras levé tout entier était pris pour l'avant-bras, et le bras revenu devant le ventre pour le ventre), la mort couchée (images 7 à 9, crâne compris : les cheveux disparaissaient), et la course des deux sexes, image 0, où l'avant-bras plié devant le ventre était compté dans le ventre et le coude dans la main.
- **Corrigées à la relecture de 2b.5** (609 pixels, sur 275 lignes des 14 grilles) : la main proche de la marche masculine, images 0, 1, 2, 6 et 7, où une bande de 3 à 6 pixels était comptée dans le ventre, si bien qu'une tenue qui couvre le ventre sans la main (6 sur 8) barrait la main nue à chaque pas, à tous les niveaux et chez les enfants, tirés du corps masculin ; la jambe arrière de l'image 5, comptée en pied ; des pixels de pied sur la cuisse (marche des deux sexes) ; du ventre dans la main (course féminine, images 2 et 6 ; course masculine, images 3 et 5 ; lancer, image 0 ; mort, images 0 à 4) ; là où une image recopie le repos, les régions du repos (bassin, poitrine, bras) ; et la ligne des cheveux de la mort, qui variait d'une image à l'autre : aux yeux clos des images 0, 3 et 4 de la femme, le front, les paupières et les joues étaient comptés en cuir chevelu.
- **La garde des régions** (`tools/human-regions.test.ts`), deux sortes de contrôles, chacun avec ses écarts justifiés image par image ; une excuse qui ne sert plus fait échouer le test :
  - **les aires** : pour chaque animation, chaque membre (cuir chevelu, bras, avant-bras, main, cuisse, jambe, pied) et chaque image, l'aire comparée à celle du repos, entre la moitié et le double, à un pixel près, hors de 22 écarts justifiés (54 images : jambes croisées, bras tendus ou levés, corps couché, traînée de la chute). Elles attrapent un membre entier compté ailleurs (la marche féminine du prototype y échoue), pas une bande de quelques pixels : les défauts relevés à la relecture y passaient tous ;
  - **la topologie** : une région ne touche, sans contour entre elles, que ses voisines dans le corps ; un morceau de torse détaché du torse principal tient au cou, à un bras ou à une cuisse ; chaque main tient à un seul avant-bras, chaque pied à une seule jambe ; là où une image recopie le repos, pixel et huit voisins compris, elle en garde les régions ; là où elle en reprend la tête, même silhouette et traits sur ceux du repos ou sur son visage (les yeux clos de la mort), elle en garde la ligne des cheveux. Hors de 14 écarts justifiés (30 images : main lointaine que le contour isole, son avant-bras caché ; pied arrière levé derrière la jambe d'appui ; éclats de la traînée de la chute). Les grilles d'avant la relecture y échouent (183 constats), comme la mutation de la relecture : quatre pixels de la main proche, image 3 de la marche masculine, passés au ventre.
- **Tons gardés tels quels**, nommés dans les données : les contours (`#13131c`, `#140b0f`), l'œil (`tones.eye`, `#27130f`, que les réductions gardent d'un bloc où il compte assez), puis le sourire `#ffffff`, les lèvres `#f1868e` et les paupières `#ba756a`, comme dans les planches de l'auteur, qui ne les changent pas d'une teinte à l'autre. Les joues `#e65656` sont un ton de peau de rang 3, comme l'auteur les a traitées ; le point `#664d46`, un ton du sous-vêtement de rang 3, qui devient un pli du tissu.

### 3. Les habits

- **Tissus : les huit palettes `CLOTH` de l'auteur** (Portrait64, `avatargenerator/portrait64/palettes.py`, « palettes fournies par l'utilisateur, conservées sans modification »), celles que 2b.9 posera sur les habits des portraits, rangées comme les autres rampes : lumière (leur quatrième ton), base, ombre, ombre profonde. Forêt, bordeaux, marine, ocre, violet, lin, cuir, charbon (`forest`, `burgundy`, `navy`, `ochre`, `violet`, `linen`, `leather`, `charcoal`). Aucun tissu ni ton ajouté : les tissus du prototype (fourrure, laine, et les autres refaits en OKLab) sont partis. `tools/author-palettes.test.ts` vérifie que chaque rampe des données, peaux, cheveux, gris et tissus, est une palette de l'auteur ; la liste de ses écarts déclarés est vide.
- **Pièces et tenues, en données** (`data/appearance.json`) : une pièce est un tissu et les régions qu'elle couvre ; une tenue donne ses pièces pour une femme, un homme, un enfant et un nourrisson, la dernière l'emportant là où deux se chevauchent. Huit tenues, une par habit de culture embryonnaire :

  | Tenue | Femme | Homme | Enfant | Nourrisson |
  |---|---|---|---|---|
  | `tunic` (tunique) | lin : épaules, torse, bras, bassin, cuisses, jambes | lin : de même, jambes nues | lin, comme l'homme | lin : torse, bassin |
  | `loincloth` (pagne) | cuir : poitrine, bassin | cuir : bassin | cuir : bassin | cuir : bassin |
  | `furs` (fourrures) | charbon : du cou aux jambes ; cuir : pieds | charbon : du cou aux cuisses ; cuir : jambes, pieds | comme l'homme | charbon : torse, bassin |
  | `robe` (robe) | bordeaux : des épaules aux jambes, avant-bras compris | bordeaux : jusqu'aux cuisses ; cuir : pieds | bordeaux : jusqu'aux cuisses | bordeaux : torse, bassin |
  | `dyed` (teinte) | marine : épaules, torse, bras, avant-bras, bassin ; lin : cuisses, jambes ; cuir : pieds | marine, de même ; charbon : cuisses, jambes ; cuir : pieds | marine, sans les avant-bras ; charbon : cuisses | marine : torse, bassin |
  | `wrap` (pagne long) | ocre : torse, bassin, jambes | ocre : bassin, cuisses | de même | ocre : bassin |
  | `mantle` (manteau) | forêt : épaules, bras, torse, bassin, jambes | forêt : épaules, bras, poitrine ; cuir : ventre, bassin, cuisses | de même, jusqu'au bassin | forêt : torse, bassin |
  | `sash` (écharpe) | violet : épaules, torse, bassin, jambes | violet : jusqu'au bassin ; charbon : cuisses | violet : torse, bassin | violet : torse, bassin |

- **Ton pour ton** : chaque pixel de peau ou de sous-vêtement d'une région couverte prend le ton de même rang du tissu ; d'une région nue, le ton de même rang de la palette de peau ; du cuir chevelu, celui des cheveux (§ 5). Le contour, l'œil et les traits restent ceux de la planche : le modelé et le contour d'origine sont gardés, à la position près de chaque pixel.
- **Le sous-vêtement ne se montre jamais** : le build déduit des pixels de chaque corps les régions où se trouve du sous-vêtement (la poitrine et le bassin de la femme, le bassin des autres) et refuse toute tenue qui en laisse une nue. Rien n'est écrit en dur sur les régions.
- **Contraste du tissu et de la peau** : un tissu trop proche de la peau qui le porte fait paraître nu de loin. Écart OKLab × 100 entre les tons de base, la flèche donnant le tissu de rechange déclaré et son écart :

  | Tissu | très claire | claire | medium | olive | brune | très brune |
  |---|---|---|---|---|---|---|
  | forêt | 36,6 | 31,7 | 17,5 | **14,3** → lin 18,9 | **11,1** → ocre 20,3 | 18,0 |
  | bordeaux | 40,1 | 34,8 | 18,1 | 15,4 | **5,0** → ocre 20,3 | **13,2** → ocre 31,4 |
  | marine | 39,2 | 34,8 | 21,5 | 18,7 | **14,4** → ocre 20,3 | 18,5 |
  | ocre | 21,7 | 16,3 | **5,5** → marine 21,5 | **6,5** → marine 18,7 | 20,3 | 31,4 |
  | violet | 36,0 | 31,3 | 17,1 | **14,7** → marine 18,7 | **12,1** → ocre 20,3 | 19,3 |
  | lin | **7,4** → marine 39,2 | **4,2** → marine 34,8 | 16,4 | 18,9 | 33,8 | 44,9 |
  | cuir | 36,7 | 31,3 | **14,6** → lin 16,4 | **11,4** → lin 18,9 | **4,0** → lin 33,8 | 15,1 |
  | charbon | 45,8 | 40,8 | 25,4 | 22,2 | **10,8** → lin 33,8 | **9,9** → lin 44,9 |

  La règle : une pièce qui couvre la poitrine, le ventre ou le bassin reste à 15 au moins de la palette de peau qui la porte. Une exception se déclare en données, par un tissu de rechange sur cette palette de peau (`onSkin`), lui-même à 15 au moins ; le test échoue sinon, et le seuil est soumis à l'auteur. L'autre remède, une tenue de culture loin du teint dominant, ne tient pas aux métis ni aux groupes mêlés. La règle ne suffit pas seule : un tissu couleur de peau, même loin de celle qui le porte, fait paraître nu. Le prototype donnait le cuir pour rechange au lin sur les peaux claires ; dans Chromium, ses tuniques collantes se lisaient comme des corps nus à la peau brune (Pixel 5, zoom 8). Le rechange du lin est donc la marine.
- **D'où vient la tenue en phase 2** : de la culture, comme l'habit de 2.9 — les cultures embryonnaires prennent à tour de rôle les tenues de `cultureOutfits` —, puis du corps, puis de la palette de peau pour le rechange ; l'aîné garde la tenue de l'adulte. Le rang et le métier de REN-04 s'y ajouteront en pièces posées par-dessus (manteau du chef, jambières du chasseur), toujours par substitution ; l'équipement (lance, panier) demandera des pixels nouveaux, dans un calque de motifs propres au jeu.
- **La bannière** d'un groupe prend le premier tissu de la tenue de sa culture, sans rechange : la couleur de loin annonce celle de près.

### 4. Le teint

- Le worker envoie un code de teint de 0 à 15 (`skinCode`, `src/core/visual.ts`) ; chaque palette de peau déclare le dernier code qu'elle prend (`upTo`) : 2, 5, 7, 10, 13 et 15, de la plus claire à la plus foncée. Le schéma les veut croissants jusqu'à 15, et au plus aussi nombreux que les bits du code d'apparence le permettent.
- **Le portrait prend les mêmes tons** jusqu'à 2b.9 (`src/render/looks.ts`, partagé avec la carte) : la lumière, la base et l'ombre de la palette de peau de son code de teint, les tons des cheveux de son allèle au cran de gris de la carte, et le premier tissu de la tenue de sa culture, rechange compris. La rampe `skin` interpolée, `skinColor`, `greyed`, `shade` et `cultureCloth` partent ; aucune couleur d'individu n'est plus calculée. La couleur des allèles des cheveux part de `data/genetics.json` : leurs tons n'ont qu'une source, carte et portrait.

### 5. Cheveux et âges

- **Cheveux** : les figures sont chauves. Le cuir chevelu prend les tons de la rampe de l'allèle exprimé, prise dans `HAIR` de l'auteur, à trois tons (noir, châtain, blond, roux ; `blond_clair` et `brun` attendent des allèles) ; l'ombre profonde prend le plus sombre, sans ton ajouté. La figure porte ainsi des cheveux ras, qui suivent son modelé. Le **grisonnement** suit le gris puis le blanc de l'auteur : au premier cran, la lumière et la base prennent le gris ; au deuxième, tous les rangs ; au troisième, le blanc (`greying`). La calvitie de `ages.bald` ne se voit pas : le code d'apparence n'en dit rien.
- **Enfants et nourrissons** : aucune planche. Retenu, parmi l'adulte réduit d'un bloc, les mini-sprites de 2.9, des planches à demander et un corps composé : **le corps composé**, tiré du corps masculin pour les deux sexes (le torse d'un enfant n'a pas de poitrine), la tête réduite moins que le corps, le menton posé sur le cou, par la même réduction que les versions réduites, donc sans couleur nouvelle : trois tailles d'enfant, de 26, 31 et 36 rangées, et un nourrisson de 19 rangées, au niveau de la planche (`young`), choisies d'après la stature. Repos et marche seulement.
- **Le nourrisson porté** se dessine, comme depuis 2b.3, contre sa mère, à 0,2 case d'elle, au repos, tourné comme elle. Les planches n'ont aucune pose où l'on porte.
- **Aînés** : la figure de l'adulte, que le grisonnement distingue, à sa stature.

### 6. Les animations

- **Les sept rangées**, nommées dans `data/humans.json` : `idle` (repos, 5 images, une respiration), `walk` (marche, 8), `run` (course, 8), `jump` (saut, 4), `fall` (chute, 4, bras levés), `throw` (lancer, 6), `death` (mort, 10, sans boucle). Toutes sont vérifiées et habillées par les tests ; le jeu ne range que le repos et la marche.
- **Montrées dès 2b.5** : la marche quand l'individu avance sur une étape, le repos sinon. Course, saut, chute et lancer attendent 2b.8, qui les choisira par `animationOf` (`src/render/humans.ts`) et une table des données.
- **Cadence** : la marche fait ses 8 images en deux pas du rendu (`steps`, `STEP_MS` de l'ADR 0014), le repos une image toutes les 260 ms (`frameMs`). L'image est une fonction pure (`animationFrame`) de l'horloge de la marche du rendu, qui n'avance qu'avec l'instant affiché, et d'une phase propre à chacun, tirée de son identifiant (`splitmix32`) : le même individu, au même instant affiché, montre toujours la même image.
- **Sens** : la figure des planches regarde l'ouest ; qui va vers l'est est retourné, par une échelle négative autour de ses pieds, sans texture de plus. Le sens vient du pas horizontal de l'étape en cours ou de la dernière, gardé d'une image des groupes à l'autre par le miroir des positions (`src/app/frames.ts`) : un immobile ne se retourne plus au pas mensuel. Sans étape connue, il vient de la phase de l'identifiant ; le porté prend le sens de sa mère, et la phase de sa mère quand elle n'a pas d'étape. Les deux défauts du prototype relevés par la critique (porté tourné à l'opposé, immobiles qui se retournent) sont corrigés et testés.
- **Pause et signature de l'image** (ADR 0010) : l'horloge de la marche est figée en pause, rien ne s'anime, et l'image ne se redessine pas ; dès que l'instant affiché change, le calque se refait et son `drawVersion` augmente, que lit la signature.

### 7. Les versions réduites

- **Cinq niveaux de motifs**, en données (`levels`) : la planche (adulte de référence de 43 rangées), réduite au facteur 1,5 (29), 2 (22), 3 (14) et 4 (11). Le contour d'origine est gardé à la planche ; il est retracé là où la forme a trois pixels d'épaisseur au moins aux facteurs 1,5 et 2 ; il n'y en a pas aux facteurs 3 et 4, où il enfermait une tête de trois pixels de large et cachait cheveux et visage (planches comparées). Variantes de hauteur : une seule à la planche, trois ailleurs, choisies sur la stature, les mêmes à tout zoom.
- **Méthode, le vote par surface** (`reduceRoles`) : un pixel de la réduction est opaque si son bloc l'est assez ; il prend la région la plus présente du bloc, au rang moyen de ses pixels, l'œil s'il compte assez, ou l'ombre profonde si des lignes de contour intérieures en couvrent la moitié. Chaque rôle d'une réduction est un rôle de la planche, ou le contour : aucune couleur nouvelle, et les régions suivent, si bien qu'une réduction s'habille comme la planche. Écartée, la décimation : elle crible la figure de points de contour et perd les yeux.
- **Choix du niveau** : le plus fin dont l'adulte de référence, à un pixel physique par pixel de motif, ne dépasse pas 1,25 fois la cible ; k = arrondi(cible / rangées), au moins 1, le même pour tous les individus de la vue. La règle ne dépend que de la cible : le détail ne recule jamais quand on zoome, à toute densité d'écran. La taille reste à 25 % de la cible, sauf quand la planche passe d'un pixel physique par pixel de motif à deux (de −32 % à l'échelle 21 à +30 % à l'échelle 22).

  | Écran et zoom | Cible (px physiques) | Niveau | k | Adulte (px physiques) | Adulte (px CSS) | Avant 2b.5 (px CSS) |
  |---|---|---|---|---|---|---|
  | PC, zoom 3 | 9 | facteur 4 | 1 | 11 | 11 | 9 |
  | PC, zoom 4 | 12 | facteur 3 | 1 | 14 | 14 | 9 |
  | PC, zoom 8 | 24 | facteur 1,5 | 1 | 29 | 29 | 27 |
  | PC, zoom 16 | 48 | planche | 1 | 43 | 43 | 45 |
  | PC, zoom 24 | 72 | planche | 2 | 86 | 86 | 72 |
  | Pixel 5, zoom 3 (8 px physiques par pixel de carte) | 24 | facteur 1,5 | 1 | 29 | 10,5 | 9,8 |
  | Pixel 5, zoom 4 (11) | 33 | facteur 1,5 | 1 | 29 | 10,5 | 13,1 |
  | Pixel 5, zoom 8 (22) | 66 | planche | 2 | 86 | 31,3 | 22,9 |
  | Pixel 5, zoom 16 (44) | 132 | planche | 3 | 129 | 46,9 | 49,1 |
  | Pixel 5, zoom 24 (66) | 198 | planche | 5 | 215 | 78,2 | 72 |

  Hauteurs relevées dans Chromium sur les trois graines : celles du tableau, à deux rangées près selon l'image de la marche et la variante.
- **REN-04 et REN-08** : au zoom le plus faible des individus, le facteur 4 tient le rôle du mini-sprite à l'échelle de la carte, de 10 à 12 pixels ; plus près, les niveaux plus fins sont l'écart décidé par l'auteur pour 2b.3 : une résolution propre aux individus, une densité k commune à tous ceux d'une vue, une autre pour la carte et les bannières, jamais deux dans un même dessin (ADR 0014, § 6). Les sprites de la planche ne se montrent jamais plus petits que leurs pixels : chaque niveau est un motif dédié, tiré d'eux, dont chaque pixel fait k × k pixels physiques. Le prix : un pixel d'individu est bien plus fin qu'un pixel de carte, de 3 fois (PC, zoom 3) à 21 fois (PC, zoom 21) : 8 fois au zoom 8 du PC (1 pixel physique contre 8), 16 fois au zoom 16, et 8 fois sur Pixel 5 au zoom 3 (1 pixel physique, 0,36 pixel CSS), au lieu de 2,7 à 3,2 fois en 2b.3 aux mêmes zooms.
- **Les mini-sprites de 2.9 sont retirés** (`assets/pixel/sprites/`), et non gardés comme niveau le plus grossier : de face, à l'ombrage calculé, ils changeraient de style au zoom 3. Les bannières restent.

### 8. Rendu et coût

- **Un shader de palettes**, option (a) de la critique (`src/render/humanShader.ts`) : l'atlas des rôles est une texture (le rôle dans le rouge) ; chaque apparence visible range sa palette, 128 texels, dans une texture des palettes de 1 024 texels de large, à sa première vue, une fois pour le monde ; chaque individu est une particule d'un même `ParticleContainer`, dont le cadre est son motif dans l'atlas des rôles et dont la teinte désigne la place de sa palette. Le shader lit le rôle du pixel, puis sa couleur. Plus de texture recolorée, de page ni de lot pour les humains : un appel de dessin pour tous, quel que soit leur nombre. Le retournement passe par l'échelle de la particule.
- **Bornes** : l'apparence tient sur 15 bits (palette de peau, allèle des cheveux, cran de gris, tenue, sorte de corps, `LOOK_BITS`), et les données ne peuvent déclarer plus de 8 palettes de peau, 16 tenues ni 16 allèles des cheveux (schéma et `checkContent`) ; la texture des palettes commence à 16 rangées (128 apparences, 64 Kio) et double quand elle est pleine, jusqu'à 2 048 rangées (16 384 apparences), et `checkContent` refuse des données qui permettraient plus d'apparences (aujourd'hui 3 072). Une vue qui en montre beaucoup ne recolore rien à chaque image : le test le vérifie.
- **Les bannières** gardent leurs textures recolorées, rangées dans les pages de l'atlas dynamique (`pages.ts`, ADR 0014), une poignée par vue.
- **Mémoire sur le GPU** : l'atlas des rôles, 1 024 × 129 texels RGBA (516 Kio), et les palettes, 64 Kio au départ. Le prototype, qui recolorait une texture par motif et par apparence, en rangeait jusqu'à 44 à 51 pages de 256 Kio au niveau de la planche (mesures de la critique) ; 599e410, avec ses mini-sprites, une à trois.
- **Mesures** : voir le tableau du coût (§ 8 bis), avant et après, sur Pixel 5 au zoom 4 ralenti ×4 et sur PC 1 920 × 1 080 au zoom 11.

### 8 bis. Coût mesuré

Foules de débogage (`?crowd=N`) sur la graine `pixelciv`, relevés du panneau de débogage, une valeur par seconde pendant six secondes à ×1, puis en pause ; 599e410 (avant) et la réalisation (après), aux mêmes positions. Pixel 5 ralenti ×4 par CDP. Fourchettes des six relevés.

| Écran, zoom, foule | Dessinés | Mise à jour + rendu (ms) | Positions + tri + sprites (ms) | Apparences ou textures : dans l'image, gardées | Pages | Appels de dessin | Mémoire (JS) |
|---|---|---|---|---|---|---|---|
| Pixel 5 ×4, zoom 4, 2 000 : avant (mini-sprites) | 1 580 à 1 960 | 4,1 à 13,8 + 1,3 à 9,4 | 1,7 à 5,7 + 0,4 à 1,1 + 1,1 à 6,7 | 1 065 à 1 180, 1 890 | 2 à 3 | 5 | 10,1 Mo |
| après (facteur 1,5, k = 1) | 1 615 à 1 960 | 3,5 à 8,4 + 2,2 à 3,2 | 1,4 à 4,7 + 0,3 à 0,7 + 0,8 à 1,7 | 376 à 390, 392 | 0 | 5 | 12,1 Mo |
| après, zoom 5 (planche, k = 1) | 1 640 à 1 960 | 4,4 à 8,1 + 2,3 à 3,8 | 1,8 à 4,7 + 0,5 à 0,8 + 0,8 à 2,4 | 378 à 392, 395 | 0 | 5 | 12,1 Mo |
| PC 1 920 × 1 080, zoom 11, 4 000 : avant | 3 330 à 3 980 | 1,3 à 5,8 + 0,4 à 3,6 | 0,6 à 1,7 + 0,1 à 0,6 + 0,5 à 3,7 | 1 563, 2 765 | 2 à 3 | 5 | 10,1 Mo |
| après (facteur 1,5, k = 1) | 3 350 à 3 980 | 1,6 à 5,1 + 0,8 à 1,0 | 0,8 à 2,2 + 0,1 à 3,0 + 0,3 à 0,9 | 440 à 449, 452 | 0 | 5 | 13,6 Mo |
| après, zoom 12 (planche, k = 1) | 3 050 à 3 930 | 1,6 à 3,2 + 0,7 à 1,2 | 0,7 à 2,0 + 0,2 à 0,4 + 0,4 à 0,7 | 433 à 451, 452 | 0 | 5 | 13,6 Mo |

- **Pires cas de la critique** : sur Pixel 5 au zoom 4 et sur PC au zoom 11, le prototype, au niveau de la planche, gardait 4 000 à 4 700 textures dans 44 à 51 pages et faisait 12 à 41 appels de dessin. La réalisation y montre le facteur 1,5 (la règle du § 7) ; au niveau de la planche (Pixel 5 au zoom 5, PC au zoom 12), elle garde moins de 460 palettes, aucune page, et fait 5 appels de dessin, carte comprise, comme 599e410.
- **Mémoire des textures des individus** : 772 Kio (l'atlas des rôles, et la texture des palettes, passée de 16 à 64 rangées pour quelque 450 apparences) ; le tas JavaScript gagne 2 à 3,5 Mo, l'atlas des rôles décodé et les tables des motifs.
- **En pause**, rien ne se refait : positions, tri et sprites ne coûtent rien, avant comme après.
- La mise à jour des sprites coûte moins qu'avant (une particule change de cadre, sans texture à changer) ; le rendu par PixiJS un peu plus sur Pixel 5 ralenti, de 2 à 4 ms. Ces temps viennent de SwiftShader, qui rend en logiciel ; ceux de vrais appareils sont à demander à l'auteur.

### 9. Les tests

Les tests ont été mis à l'épreuve de 47 mutations du code, des données et des grilles (script hors du dépôt) : chacune retire ce qu'un test protège, et chacune fait échouer ce test, ou le build de l'atlas qu'il charge. Parmi elles : remettre la marche féminine du prototype, sauter la tenue d'une région, inverser un rang de peau, changer un ton gardé, ôter un tissu de rechange, oublier le retournement autour des pieds, prendre la phase du porté au lieu de celle de sa mère, oublier le sens gardé à l'arrêt, recolorer à chaque image, ne plus augmenter la version du calque.

- **Planches** (`tools/human-sheets.test.ts`) : les douze planches de teinte sont leur base substituée par les palettes des données, tout autre pixel identique, alpha compris ; tons de chaque base, alpha 0 ou 255, grille de cases et cases vides.
- **Habillage** (`tools/human-dressing.test.ts`) : pour chaque tenue, chaque palette de peau et chaque corps adulte, chaque image des sept animations est comparée pixel à pixel à la planche de base : tons gardés identiques ; pixel d'une région couverte au ton du tissu de même rang que le ton de la planche ; pixel d'une région nue au ton de peau de même rang ; aucun ton de sous-vêtement ; sans tenue, la planche de l'auteur.
- **Régions** (`tools/human-regions.test.ts`) : les aires des membres et la topologie des régions (§ 2) ; crâne, bras et jambes présents à chaque image debout.
- **Palettes de l'auteur et contraste** (`tools/author-palettes.test.ts`) : chaque rampe est une palette de l'auteur ; la règle du contraste et ses tissus de rechange (§ 3).
- **Atlas et réductions** (`tools/human-atlas.test.ts`, `src/gen/humans.test.ts`) : empreinte de l'atlas du jeu et de celui de toutes les animations ; une grille fausse refusée avec le nom du pixel ; rôles d'une réduction pris dans ceux de la planche ou le contour ; pieds sur la ligne ; hauteurs des variantes et des enfants ; refus au build d'une tenue qui montre le sous-vêtement et d'un pack que `CREDITS.md` ne cite pas.
- **Couleurs et empreintes des planches habillées** (`src/render/humans.test.ts`) : toutes les apparences et tous les corps reçoivent, à chaque rôle, une couleur déclarée de son rang ; empreintes des planches habillées d'une apparence par tenue, à chaque niveau, adultes, enfants et nourrisson, si bien que toute retouche d'une grille, d'une réduction ou d'une palette se voit en revue ; bits de l'apparence ; corps, variante et cadence. `tools/human-sources.test.ts` : aucun module des humains n'emploie de couleur calculée.
- **Choix du niveau et disposition** (`src/render/crowd.test.ts`) : le tableau du § 7, la monotonie du niveau aux densités 1, 2 et 2,75, positions entières, retournement autour des pieds, porté tourné comme sa mère même sans étape.
- **Calque** (`src/render/people.test.ts`, `src/render/humanShader.test.ts`) : l'appui désigne ce qu'on voit, sprites retournés compris, aux densités 1 et 2,75 ; palettes rangées une fois, texture qui double, aucune recoloration à chaque image ; `drawVersion` et signature de l'image.
- **Sens** (`src/app/frames.test.ts`) : le sens du pas, gardé à l'arrêt et d'une image des groupes à l'autre.
- **Portrait** (`src/ui/Portrait.test.ts`) : la peau et les cheveux du portrait sont ceux de la carte, au même code de teint et au même cran.
- **Données** (`src/core/data/data.test.ts`) : refus de chaque valeur hors bornes.
- **Empreintes de l'état** : celles de `src/sim/state.test.ts` (f363d517, 567d06a4 et cd841d8f) ne bougent pas : 2b.5 ne touche que le rendu et les données d'apparence, que la simulation ne lit pas.

### 10. Crédits et licence

- `CREDITS.md`, section « Pack de sprites » : intégré à la tâche 2b.5. « 2D Pixel Art Male and Female Character », version gratuite, de GandalfHardcore, <https://gandalfhardcore.itch.io/2d-pixel-art-male-and-female-character>. Planches versées par l'auteur dans `sprites/humans/skin/` ; licence vérifiée par lui le 15 novembre 2026 : elle permet de les modifier et de les distribuer avec le jeu, comme dans ce dépôt public ; ses termes ne sont pas recopiés, la page du pack n'étant pas joignable depuis le conteneur. L'écran des crédits (IHM-08) reprendra l'entrée ; d'ici là, `licenses.txt`.
- **Contrôle du build** : celui de l'ADR 0008 ne voit que les paquets npm. L'extension de l'atlas le complète : `data/humans.json` nomme le pack (titre, auteur, lien), et le build échoue si `CREDITS.md` n'en cite pas le lien ; `tools/credits.test.ts` vérifie la ligne du pack.

## Conséquences

- La carte montre de près des humains habillés selon leur culture, à cinq niveaux de détail, sans qu'aucune couleur ne soit calculée ; les tuiles ne changent pas : hors du calque des individus, l'image est celle de 599e410 au pixel près, aux zooms 1 à 24, sur les trois graines, sur PC et sur Pixel 5.
- Les humains ne coûtent qu'un appel de dessin, et plus aucune texture recolorée.
- **Essais dans Chromium** (PC 1 280 × 720 et Pixel 5 au doigt, graines `pixelciv`, `graine` et `autre`, zooms 1, 2, 3, 4, 5, 8, 16 et 24, foule de débogage de 300 individus après 30 jours ; à `graine` et `autre`, la foule ne se voit qu'aux zooms 1 à 4, et 8 pour `autre`) : hors du calque des individus, 0 pixel ne diffère de 599e410 ; à l'écran, toutes les couleurs des individus sont déclarées, aucun ton de sous-vêtement ni de peau des planches ne paraît ; un seul k par vue, positions entières. En pause, aucun pixel ne change en 1,5 s ; à ×1 et à ×16, la marche s'anime. Sur 224 relevés d'un immobile d'une image à l'autre, en quatre mois à ×1 puis vingt à ×16, aucun retournement ; 205 portés relevés contre leur mère, tous tournés comme elle. Une partie de cinq ans et demi montre nourrissons, enfants et adultes, aux couleurs toutes déclarées. Aucune erreur de console.
- Ajouter une tenue, un tissu, une teinte ou des cheveux ne demande que des données ; une animation, une ligne de `data/humans.json` et ses grilles ; une planche nouvelle, ses grilles.
- Les grilles de régions sont du contenu à entretenir à la main : 90 images, que gardent les aires et la topologie des régions (§ 2), si bien qu'une erreur de quelques pixels s'y voit aussi.

## Facultatifs de la critique

- **Appliqués** : les niveaux intermédiaires (facteurs 1,5 et 3, tolérance de 25 % revenue sauf au passage de k = 1 à 2 de la planche) ; les régions dans les données ; la bannière accordée au premier tissu de la tenue ; le crédit dans `licenses.txt`, et la phrase sur ce que le jeu distribue reformulée (§ 1) ; l'avertissement de Vite supprimé ; l'atlas du jeu réduit aux animations montrées (598 motifs au lieu de 1 430).
- **Écarté : un niveau le plus grossier retouché à la main, avec contour.** Les planches comparées montrent qu'aux facteurs 3 et 4 le contour retracé enferme la tête : sans contour, cheveux, visage et tenue se lisent mieux. Une retouche à la main de deux niveaux, pour 90 images, n'a de sens qu'une fois le style des tenues tranché par l'auteur ; le vote reste la source, et une grille retouchée pourra la remplacer, vérifiée comme les autres.
- **Écarté : des masques en PNG indexés.** Les grilles de texte se lisent dans une revue de code, ligne à ligne, et les tests des aires et de la topologie les gardent ; AST-04 admet les deux formes. Les convertir est mécanique, si l'auteur préfère peindre les régions dans un éditeur de pixels.
- **Écarté : l'atlas dans un fichier à part.** Réduit aux animations montrées, il ne pèse plus que 46,5 ko compressés dans le paquet principal ; un chargement différé ajouterait un état « humains pas encore prêts » à la vue rapprochée, pour peu.
- **Base et portée de la PR** : la branche part de 2b.4 (PR #10, ouverte) ; sa PR s'ouvrira contre la branche de 2b.4, ou après la fusion de #10. L'accord du portrait va jusqu'aux cheveux et à l'habit, parce que la couleur des cheveux n'a plus qu'une source ; à confirmer par l'auteur.
- **Essais complémentaires** : paires de tuiles sur Pixel 5 comprises (§ Conséquences), partie naturelle après plusieurs mois, et inversion de la lumière des figures retournées, signalée ci-dessous.

## Ce qui reste à décider par l'auteur

Planches de revue : chaque tenue sur chaque peau, à chaque niveau ; les niveaux côte à côte ; enfants et nourrisson ; le grisonnement ; et les captures avant et après, aux zooms 1 à 24, sur PC et sur Pixel 5.

**Le style**
1. **Les tenues** : huit tenues sur les huit tissus de l'auteur, collantes par construction (la substitution ne peut ni évaser une jupe, ni ajouter un pan) ; une robe se lit comme une combinaison.
2. **Le tissu de rechange** : sur une peau dont il ne se détache pas, un tissu en prend un autre, si bien qu'une même culture s'habille de marine sur les peaux claires et de lin ailleurs (la tunique), ou d'ocre sur les peaux brunes (la robe). Le seuil de 15 et les rechanges sont à valider sur les planches ; le cuir, l'ocre et le bordeaux, proches de certaines peaux, peuvent encore faire paraître nu en tenue collante.
3. **Femmes et hommes** se distinguent par la coupe des tenues (jambes couvertes ou non, poitrine couverte au pagne), et à peine aux facteurs 3 et 4, où tous ont les cheveux ras ; 2b.3 donnait aux femmes cheveux longs et robe.
4. **Le grisonnement** : ses trois crans se lisent à la planche et au facteur 1,5, à peine aux facteurs 3 et 4.
5. **Les tons gardés** : sourire blanc, lèvres roses et paupières restent ceux de la planche sur toutes les peaux, comme dans les planches de l'auteur, et paraissent clairs sur les peaux foncées.
6. **Cheveux ras** pour tous, sans calvitie ; des coiffures demanderaient des pixels nouveaux.
7. **La lumière des retournés** : le modelé des planches est éclairé d'un côté ; retournée pour aller vers l'est, une figure l'est de l'autre, si bien que la moitié d'une foule est éclairée à l'opposé de l'autre. Une seconde planche, ou un retournement des seuls rangs de lumière et d'ombre, le corrigerait.

**Les pertes et les écarts**
8. **Le teint** passe de 16 nuances interpolées à 6 palettes de l'auteur (seuils `upTo`).
9. **Le contour** : gardé à la planche, retracé aux facteurs 1,5 et 2, absent aux facteurs 3 et 4, alors que la consigne dit « en gardant le contour d'origine ».
10. **La densité** : un pixel d'individu est 8 fois plus fin qu'un pixel de carte au zoom 8, 16 fois au zoom 16, au lieu de 2,7 à 3,2 fois en 2b.3 (§ 7). Une autre règle prendrait le niveau en pixels CSS (k au moins égal à la densité de l'écran) : des figures plus petites ou plus grossières sur téléphone, mais des pixels plus proches de ceux de la carte.
11. **La règle du niveau** : 25 % de la cible au lieu des 25 % de l'ADR 0014 à densité égale, mais de −32 % à +30 % quand la planche passe de k = 1 à 2 (PC, zooms 21 et 22). Sur Pixel 5 au zoom 4, l'adulte fait 10,5 pixels CSS au lieu de 13,1.
12. **Les mini-sprites remplacés** par le facteur 4, de 11 rangées au lieu des 6 à 10 de REN-04, de trois quarts au lieu de face ; au zoom 3 du PC, les mini-sprites de 2b.3, aux bras écartés, se lisaient mieux.
13. **Écarts au PRD** : AST-01 demande les originaux du pack « avec vêtements » : la consigne a choisi les planches sans vêtements, habillées par le jeu ; AST-03 veut des mini-sprites générés : ils sont tirés du pack.
14. **Les sources** : le jeu part des deux bases et non des douze planches, équivalence prouvée par test.
15. **Le portrait change avant 2b.9** : teint, cheveux et habit pris dans les palettes de la carte.
16. **Une seule variante à la planche** : la taille propre des adultes ne s'y voit pas.
17. **Enfants composés** d'après le corps masculin, et nourrisson debout contre sa mère, faute de pose où l'on porte.
18. **Glissement des pieds** : à ×1, un marcheur avance vite à l'écran, et la marche s'anime à la cadence de 2b.3, si bien que ses pas ne suivent pas le sol.
19. **Les animations de 2b.8** : course, saut, chute, lancer et mort sont prêts et vérifiés, à associer aux activités.
20. **Visages réduits** : au facteur 1,5 (PC aux zooms 8 à 11, Pixel 5 aux zooms 3 et 4), l'œil et les sourcils, gardés d'un bloc où ils comptent assez, s'étalent en une bande sombre sur le visage, surtout chez les enfants composés, dont la tête est plus grande ; un seuil de l'œil propre à chaque niveau l'atténuerait, au prix d'yeux perdus sur certaines images.
