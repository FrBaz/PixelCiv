# ADR 0017 — Décor en objets

Statut : accepté · 20 novembre 2026 · tâche 2b.6, première moitié : arbres, conifères, buissons et rochers. Réalisé sur la branche `claude/2b-6-decor-gibier`, partie de la tête de 2b.5 (db64b76, PR #11, ouverte, non fusionnée) : la taille et la densité du décor suivent celles des humains, et donc le point 10 de l'ADR 0016 (règle de densité), encore soumis à l'auteur. Le gibier (ADR 0018) suivra, dans un second ticket et une seconde PR, sur le calque commun du § 7. Conçu sur un prototype, critiqué, puis réalisé ; les mesures sont celles de ce conteneur à quatre cœurs, où Chromium rend en logiciel (SwiftShader) : ses temps de GPU et ses images par seconde ne disent rien d'un vrai appareil. Les interprétations et écarts de la dernière section sont soumis à l'auteur.

## Contexte

La consigne fait foi (`docs/design/corrections-phase-2.md`) : « Arbres, conifères, buissons et rochers en objets, posés d'après les couches `trees` et `shrubs` et les gisements, au plus un arbre par case de forêt, avec ombre portée et variantes saisonnières » ; les tuiles de la carte ne changent pas. MON-10 veut une flore par biome en données, REN-08 une seule densité de pixels par vue, que l'ADR 0014 (§ 6) applique au décor en lui donnant la densité des individus, REN-09 des palettes par rôles, REN-10 et C1 (D10) des saisons sans recuisson, par palettes, sans le mélange libre de couleurs qui crée des teintes hors palette ; AST-04 des sources éditables rangées en atlas au build. Les tuiles cuites portent déjà, sur les cases de forêt, des houppiers en taches de 2 × 2 pixels de carte (`bake.ts`).

Mesuré sur trois graines (pixelciv, graine, autre) : la tuile `forest` couvre 28,0 à 39,2 % des terres ; la couche `trees` promet 0,23 à 0,32 arbre par case de terre, dont 96 à 97 % sur cette tuile ; `shrubs` 0,18 à 0,21 buisson ; les gisements touchent 4,9 à 5,8 % des terres. Les couches sont fixes : le pinceau ne change que le biome.

## Décision

### 1. Quels objets, et où

- **Une fonction pure, dans `src/gen/decor.ts`**, où ESLint fait respecter les interdits du déterminisme (ADR 0003), sans PixiJS, sans DOM et sans horloge : le rendu la garde en cache, et les activités de 2b.8 pourront, dans le worker, savoir où sont les arbres et les buissons. `cellObjects(monde, x, y, occupation, places)` pose, sur une case de terre, **au plus un arbre, un buisson et un rocher**, du fond vers l'avant.
- **« Case de forêt »** : toute case de terre, et non la tuile ; c'est la densité de la couche qui décide. Un arbre se pose avec la probabilité de la densité de sa case, un buisson de même. Cette densité est celle de la couche, ramenée dans l'étendue que la génération donne au biome actuel, base × (1 ± `FLORA_VARIATION`) (`floraDensity`, `src/core/flora.ts`, commun avec `src/worldgen/resources.ts`) : une case jamais repeinte garde la sienne, une case repeinte en forêt prend des arbres de forêt, une forêt repeinte en désert les perd.
- **L'espèce** se tire parmi celles du biome (`flora.species`), selon leur poids (`flora.weights` de `data/biomes.json`, borné par le schéma, 1 par défaut) : trois feuillus pour un bouleau en forêt tempérée, quatre bois tropicaux pour un palmier en forêt tropicale, cinq en forêt pluviale, au lieu de la moitié de palmiers que donnait le tirage à parts égales.
- **Tirages** : quatorze par case, toujours dans le même ordre, d'un `splitmix32` (`src/core/rng.ts`, crédité) dont la graine mêle la clé du décor (`streamSeed(graine, 'gen.decor')`) et l'indice de la case, x ramené dans le monde : la même case donne les mêmes objets dans chaque copie du monde, de part et d'autre de la couture. Un monde Petit en compte 21 200 à 24 900 (pixelciv : 12 783 arbres, 8 924 buissons, 3 172 rochers, dont 2 556 de gisement), un Grand 90 000 à 108 000 ; un bloc de 64 × 64 cases se pose en 0,47 à 0,57 ms dans Node.
- **Exclus** : l'eau, et les cases d'une rivière ou d'un fleuve (classe 2 ou 3 de `drainage`), 1,8 à 3,6 % des cases de forêt, qui laissent voir les rivières. Les ruisseaux gardent leurs objets.
- **Place** : les pieds de l'arbre à ± 0,32 case du centre (`place.jitter`) ; le buisson à côté de l'arbre et devant lui, ou n'importe où ; le rocher du côté opposé à l'arbre.
- **Rochers** : un par case de gisement, à l'aspect de son minerai (`deposits` de `data/decor.json`) : roche nue pour la pierre, roche mouchetée pour les métaux, le charbon et les gemmes, croûte blanche pour le sel ; et des rochers épars sur les biomes de la tuile `rock` (`rocks`, 0,2 à 0,3). Montrer un gisement en mode naturel change ce que le joueur sait : la dernière section le soumet à l'auteur.
- **Occupation du sol (C1 D7, phase 3)** : chaque case porte un biome naturel et, à part, une occupation. `cellObjects` reçoit l'occupation de la case, et `data/decor.json` (`landUse`) dit, par occupation, la part de chaque sorte d'objet qu'elle garde ; seule `none` existe aujourd'hui. La phase 3 y ajoutera champs (aucun arbre), zones bâties (rien), coupes et friches (des arbres jeunes, d'une forme à dessiner), et sa couche d'occupation dans l'état ; un delta d'occupation n'invalidera que ses blocs (`DecorSource.invalidate(blocs)`), comme le pinceau aujourd'hui.

### 2. Les essences en données

- `data/flora.json` : chaque espèce reçoit `look` : sa forme (le nom de ses grilles), sa forme nue (`bare`, pour les caducs qui en ont), sa saison (`phenology` : `evergreen`, `deciduous` ou `dry`), ses rampes de quatre tons, de la lumière à l'ombre profonde : le feuillage par état (`summer`, `autumn`, `bare` pour un caduc sans grilles nues, `dry`), le bois, et le fruit (`fruit.tones` et `fruit.months`, ses mois au nord, six mois plus tard au sud). Le buisson à baies, les roseaux et le saule nain sont caducs, avec leurs tons d'hiver ; les baies se montrent de juillet à octobre, la bruyère fleurit en août et septembre, les massettes des roseaux restent de juillet à février, les noix de coco toute l'année.
- `data/decor.json` : le contour (#13131c, celui des planches et des animaux de `sprites/`), l'ombre (méthode, alpha, projection), la neige (seuil, ton profond), les seuils du feuillage, les places, la pierre, les rochers par biome, l'aspect de chaque gisement et l'occupation du sol.
- **Schémas Zod** (`src/core/data/decor.ts`, qui n'importe que zod) : couleurs `#rrggbb`, rampes de quatre tons exactement, parts dans [0, 1], projection sx ≤ 1,5 et sy ≤ 1, décalage ≤ 0,45, seuils de −30 à 40 °C, mois de 0 à 11, chacun une fois ; une caduque a son automne et sa forme nue ou ses tons d'hiver, une sèche ses tons secs, et elles seules ; l'occupation `none` existe. `checkContent` vérifie que les biomes des rochers et les minerais des gisements existent, et que chaque minerai a son aspect ; le build, que chaque forme nommée a ses grilles.

### 3. Les motifs

- **Grilles de texte par rôle de teinte** (`assets/decor/<forme>-<variante>.txt`, AST-04), décrites dans `assets/decor/README.md` : quatre rangs par région (feuillage `FfgG`, bois `WwvV`, neige `SszZ`, fruit `PpqQ`, pierre `RrkK`, minerai `UunN`, chaperon `CcjJ`), `o` le contour. Chaque grille déclare sa légende en tête (`# légende decor`) et ses pieds (`# pieds N`), sur sa dernière rangée.
- **Une légende par atlas** (`src/gen/legend.ts`) : les régions du décor et celles du gibier n'ont pas à partager leurs lettres ; chaque atlas déclare et nomme la sienne, et une grille lue avec la légende d'un autre est refusée, même faite de lettres communes (test). Le codage des rôles reste celui des humains (1 le contour, puis 16 + région × 8 + rang) : la réduction par vote de l'ADR 0016 (`reduceRoles`) s'y applique telle quelle.
- **Neige et chaperon** : la neige est une région peinte dans la silhouette, qui prend hors neige les tons de ce qu'elle recouvre ; le chaperon est le dessus du contour, au ton du contour hors neige et à celui de la neige sinon. L'ombre, région à part, est ajoutée par le build (§ 4).
- **Quarante-deux grilles originales**, à la densité de la planche des humains (adulte de 43 rangées, feuillus de 68 à 73) : vingt formes, deux ou trois variantes chacune, les formes nues des caducs comprises ; palmiers et mélèze nu redessinés. Aucun pixel d'un pack : `sprites/` n'a ni arbre, ni rocher, ni plante.
- **Atlas** (`tools/decor-atlas.ts`, module `virtual:decor-atlas`) : les cinq niveaux de `data/humans.json`, tirés au build par le vote, l'ombre ajoutée à chaque niveau, rangés en ligne d'horizon : 210 motifs dans 1 024 × 275 rôles (333 rangées au prototype), 27 % de pixels pleins, en 157 ms. Le module, en base64, fait 371 Kio.

### 4. L'ombre portée

- **Forme** : à chaque niveau, la silhouette du motif projetée au sol vers le sud-ouest, d'une lumière du nord-est, sous les pieds et à gauche, là où le motif n'a pas de pixel, en deux rôles en damier. Elle fait partie du motif : le tri par les pieds la pose au sol, sous les objets de devant, sans particule de plus.
- **Couleur** : `shadow.method` de `data/decor.json`, l'une de quatre voies, que `?shadow=` change au débogage.
  - **M3 (`ground`, retenue par défaut)** : le ton d'ombre de la palette du biome de la case sous chaque pixel d'ombre, ou celui de sa couverture de neige, tramé par Bayer comme la carte. Le shader des particules le lit à la position du pixel dans le monde, dans la texture des saisons et une texture des tons d'ombre des biomes (`shadowTones`). Fidèle aux palettes (C1, D10) : rien de vert sur la mer ni sur un biome voisin.
  - **M1 (`multiply`)** : un noir translucide (alpha 0,38), qui multiplie le sol par 0,62 ; visible partout, mais un mélange libre, que D10 écarte ; où deux ombres se croisent, le sol tombe à 0,38.
  - **Trame (`dither`)** : un pixel sur deux au ton du contour ; fidèle aux palettes, visible, mais chargée.
  - **Aucune (`none`)**.
  - M2, le ton d'ombre du biome de la case de l'arbre, est écartée : elle peint du vert sur l'eau et sur les biomes voisins.
- **Mesuré** (PC 1 280 × 720, zoom 8, couleurs distinctes de l'image ; sans ombre, M3, M1) : forêt dense de pixelciv 1 488, 1 493, 2 189 (+ 47 %) ; forêt de conifères près de la côte 1 480, 1 483, 2 186 ; savane 2 665, 2 671, 3 254. Les quatre voies coûtent autant : un rôle de plus dans les motifs, et, pour M3, deux textures et quelques uniformes de plus.
- **Limites de M3** : sur un sol de forêt, le ton d'ombre du biome est celui des houppiers cuits, et l'ombre ne se lit que de près ; sur une case de terre, un ruisseau sous une ombre prend le ton de la terre de la case, la texture des saisons ne connaissant que la case, et non le pixel. Le choix est soumis à l'auteur.

### 5. Les variantes saisonnières

- **États** : feuillé, automne, nu (motif nu des caducs qui en ont, tons d'hiver des autres), sec ; et, indépendamment, enneigé. La palette change, et, pour un caduc nu, le motif ; rien n'est recuit.
- **La neige d'un objet est celle de la carte.** `snowShare` (`src/render/seasons.ts`) part des codes de sa case dans la texture des saisons (`cellSeasonCodes`, ceux de `seasonTexels` à l'octet près : température au demi-degré, amplitude au huitième) et suit l'expression du shader de la carte, `COVER_GLSL` (`src/render/mapShader.ts`), dont `MAP_FRAGMENT` est fait, inchangé à l'octet près, et qu'un test évalue hors du GPU pour chaque code de case ; la part des forêts, `FOREST_SNOW_SHARE`, est commune (`src/core/seasons.ts`). La carte trame ensuite cette part par Bayer : un objet s'enneige quand elle atteint 0,35 (`snow.share`), quand 6 pixels sur 16 de sa case sont blancs.
- **Le feuillage** : `decorSeason(neige, saison de l'espèce, climat du feuillage, règles)` → `{ état, enneigé }` (`src/gen/decor.ts`). Le climat vient de la case : température du mois par `seasonFactor` (dmath), mois le plus froid, mois qui refroidit, pluie du mois (`rainSeasonality`). Caduc : nu sous 5 °C, en automne sous 12 °C quand le mois refroidit, feuillé sinon ; il garde ses feuilles toute l'année là où le mois le plus froid reste au-dessus de 5 °C. Sec : ses tons secs quand la pluie du mois tombe sous 0,65 de la moyenne. Persistant : toujours feuillé. Le fruit se montre à ses mois.
- **Frontière avec 2b.7** : la neige entre dans `decorSeason` comme une donnée, la part de neige de la case, fournie par la même source que le shader de la carte ; le feuillage, comme le climat de la case. 2b.7 donnera une neige à inertie, un champ d'état, et des feuillages au fil de l'année. **Exigence** : le champ de neige de 2b.7 sera lisible sur le fil principal, comme les codes de la texture des saisons aujourd'hui, pour que `snowShare` le lise ; sinon, la région neige des objets passera dans le shader des particules, qui lit déjà la texture des saisons pour l'ombre M3. Les états de 2b.7 (printemps, début et fin d'automne) seront chacun une rampe de `flora.json`, sans toucher aux motifs.
- **Effets** : le réglage des effets de 2b.7 portera aussi le décor (sa densité, son ombre) et le gibier ; le worker de cuisson, qui a les couches et découpe les mêmes blocs, reste en réserve pour la pose des blocs, si un vrai téléphone le demande.

### 6. Les zooms

Le décor se montre avec les individus, à leur niveau de motifs et à leur densité k (ADR 0014 § 6, ADR 0016 § 7), dès que l'adulte de référence vise 8 pixels CSS (zoom 3 sur PC, 2,9 sur Pixel 5) ; cette densité se calcule même sans foule, avant la première image des groupes. Aux zooms 1 et 2, les tuiles cuites et leurs houppiers figurent seuls la forêt, comme les bannières les groupes (REN-03). De plus près, les houppiers cuits restent sous les objets. En mode naturel seulement : les autres modes gardent leurs superpositions lisibles.

Objets à l'écran au centre d'une forêt dense, en juillet, monde Petit (pixelciv 427,131 · graine 109,128 · autre 310,107) :

| Écran | Zoom 3 | Zoom 4 | Zoom 8 | Zoom 16 | Zoom 24 |
|---|---|---|---|---|---|
| PC 1 280 × 720 | 3 495 · 4 090 · 3 795 | 2 578 · 2 822 · 2 545 | 1 050 · 927 · 946 | 340 · 321 · 307 | 193 · 178 · 174 |
| Pixel 5 | 2 228 · 1 149 · 1 570 | 1 348 · 783 · 1 019 | 426 · 341 · 367 | 123 · 107 · 103 | 65 · 60 · 56 |

Au zoom 3, 5 924 objets sur un PC de 1 920 × 1 080, 8 789 sur un écran de 2 560 × 1 440 pixels CSS à la densité 2. **Identité avec db64b76** (à qui seul `?at=` a été ajouté, pour viser la même case), captures à l'instant figé, trois graines, PC et Pixel 5 : aux zooms 1 et 2, 0 pixel différent ; aux zooms 3, 4 et 8, 0 pixel différent avec `?decor=off`, et, avec le décor, aucun pixel changé hors des rectangles des objets dessinés.

### 7. Le calque commun

- **Un seul conteneur** : décor, gibier et humains sont les particules du `ParticleContainer` des humains (`src/render/people.ts`), un appel de dessin pour tous ; PixiJS v8 n'admet qu'une source de texture par conteneur. Les atlas des objets se rangent sous celui des humains, dans la même texture des rôles, de même largeur (1 024 × (129 + 275) texels avec le décor), leurs palettes dans la même `PaletteTexture`, à des clés à part (`PALETTE_KEYS` : humains sous 2^15, décor de 2^20 à 2^21, gibier de 2^21 à 2^22). Les palettes du décor ont des identifiants denses, attribués à leur première composition (apparence, état, neige, fruit, biome de la neige, méthode d'ombre) : aucune valeur sentinelle. Les apparences des humains (1 536 au plus) et toutes les compositions du décor tiennent ensemble dans la texture (test).
- **Interface** (`src/render/objects.ts`), que le gibier prendra :

  ```ts
  interface ObjectSource {
    readonly atlas: ObjectAtlas; // rangé sous celui des humains à la construction du calque
    readonly version: number; // augmente quand ce qu'elle montre change hors de la vue et du mois
    update(view: ObjectView, palettes: PaletteSlots): ObjectList; // ses objets, triés par les pieds
  }
  interface ObjectView { scale; resolution; level; k; left; top; right; bottom; t; month; walkMs }
  interface PaletteSlots { readonly generation: number; slot(key, palette): number }
  class ObjectList { push(left, top, feet, width, height, motif, slot, unit, flags); sort(); order }
  ```

  Les positions d'une liste se comptent en pixels physiques depuis l'origine de la carte à l'écran (`mapOrigin`, là où camera.ts pose ses blocs) : une source immobile ne se refait pas quand la vue défile, et ses objets suivent le sol au pixel près. Une palette donne un ton RGBA par rôle (alpha nul : le rôle ne se peint pas). Un atlas déclare les rôles de son ombre portée (`shadowRoles`), que l'appui traverse : chaque atlas ayant sa légende, un même rôle peut ailleurs être peint sur l'objet. Les drapeaux (`OBJECT_FLAG`) passent dans le bleu de la couleur de la particule : `flip` retourne le motif autour de son bord droit, `ground` donne à l'ombre le ton du sol. La génération des places change quand la texture des palettes se refait (changement de monde) : une source qui garde ses places les redemande.
- **Tri** : chaque liste est triée par les pieds, puis par ordre d'ajout ; le calque la fusionne, à chaque image refaite, avec les humains triés de la disposition, et pose le i-ième dessin sur la i-ième particule. À pieds égaux, l'objet passe derrière l'humain. Aucun tri global ; la disposition des humains (`CrowdLayout`) ne connaît pas les objets.
- **Appui** : on touche ce qu'on voit (ADR 0014). Un pixel peint d'un objet devant un humain le cache à l'appui, qui ouvre alors la case ; son ombre et ses pixels transparents ne cachent rien. Le décor lui-même ne se choisit pas. Essayé dans Chromium, sur PC au zoom 16 et sur Pixel 5 au doigt au zoom 8 : chaque appui sur un houppier qui couvre un humain ouvre la case, chaque appui sur un humain visible sa fiche.
- **Version** : la signature du calque lit le mois de la carte, chaque source et sa version ; `drawVersion`, que lit la signature de l'image (ADR 0010), augmente à chaque image refaite. En pause, même instant : rien ne se refait (0 ms mesuré).
- **Ce qu'en fait le décor** (`src/render/decor.ts`) : la pose gardée par bloc de 64 × 64 cases, 64 blocs au plus, le moins récemment vu partant le premier ; la collecte par carrés de 32 cases autour de la vue, gardée tant que la vue n'en sort pas et que niveau, k, version et génération ne changent pas ; au changement de jour, seuls les états se refont, sans recollecte.
- **Ce qu'en attend le gibier** : une source de plus, dont la liste change avec l'instant ; son atlas ajouté sous celui du décor (`PeopleData.objects`), ses palettes aux clés du gibier, le drapeau `flip`, sa légende à lui (`src/gen/legend.ts`), pas d'ombre (ADR 0018 § 4), donc aucun rôle d'ombre déclaré, si bien que tous ses pixels peints cachent ce qui est derrière à l'appui ; ses hachages passent par `splitmix32` ou `streamSeed`, déjà crédités, ou sont crédités (règle D-9, ADR 0008), ce que `tools/credits.test.ts` vérifie.

### 8. Le coût

- **Par image** (foule de débogage de 2 000 sur la forêt dense de pixelciv, juillet, relevés du panneau de débogage une fois par seconde, vue fixe à × 1 ; db64b76 → cette version ; Pixel 5 ralenti × 4 par CDP) :

| Écran, zoom | Objets | Mise à jour (ms) | Rendu (ms) | Sprites (ms) | Textures du calque | Appels de dessin | Tas JS |
|---|---|---|---|---|---|---|---|
| PC 1 280 × 720, zoom 3 | 3 495 | 0,9-1,9 → 1,7-3,3 | 0,6-0,8 → 0,9-1,5 | 0,1-0,6 → 0,7-2,5 | 772 → 1 872 Kio | 7 → 7 | 12,1 → 14,5 Mo |
| PC 1 280 × 720, zoom 8 | 1 050 | 0,7-1,9 → 1,1-3,9 | 0,5-0,9 → 0,7-1,2 | 0,1-0,5 → 0,6-1,6 | 772 → 1 872 Kio | 3 → 3 | 13,6 → 14,5 Mo |
| PC 1 920 × 1 080, zoom 3 | 5 924 | 0,8-3,7 → 2,0-6,6 | 0,6-1,2 → 1,2-2,6 | 0,2-0,6 → 1,1-4,7 | 772 → 1 872 Kio | 7 → 7 | 12,1 → 14,5 Mo |
| PC 2 560 × 1 440, densité 2, zoom 3 | 8 789 | 2,0-25,7 → 9,9-16,3 | 0,6-2,4 → 1,7-3,7 | 0,4-5,0 → 2,0-12,7 | 772 → 1 872 Kio | 9 → 9 | 12,1 → 14,5 Mo |
| Pixel 5 × 4, zoom 3 | 2 228 | 4,2-15,1 → 6,0-20,1 | 1,7-3,4 → 2,2-7,2 | 0,7-2,7 → 3,1-10,0 | 772 → 1 872 Kio | 3 → 3 | 13,6 → 15,4 Mo |
| Pixel 5 × 4, zoom 8 | 426 | 1,1-7,7 → 0,6-16,7 | 1,7-3,0 → 1,6-6,9 | 0,3-1,6 → 0,2-4,9 | 772 → 1 872 Kio | 3 → 3 | 13,6 → 15,4 Mo |

  La mise à jour des sources du décor coûte de 0 à 0,17 ms par image à vue fixe : la collecte est gardée. Le reste du surcoût est l'envoi des particules et la fusion, qui croissent avec le nombre d'objets : le pire cas est un grand écran dense tout en forêt au zoom 3. Le GPU dessine en quadrilatères de motifs de l'ordre de 1,5 à 3 fois la surface de l'écran, pixels transparents compris, que le shader écarte ; son coût sur un vrai téléphone reste à mesurer par l'auteur.
- **Pose** : sur le fil principal, à la première vue de chaque bloc : 2 à 15 blocs posés en 23 à 62 ms à l'ouverture d'une vue, selon l'écran ; en défilant, un ou deux blocs à la fois (jusqu'à 18 ms de positions sur Pixel 5 ralenti × 4). En pause et à × 16, le décor ne coûte rien de plus ; en pause, avant comme après, les seules images dessinées sont celles de la mer animée (ADR 0015).
- **Mémoire et build** : la texture des rôles passe de 1 024 × 129 à 1 024 × 404 texels (+ 1,1 Mio, quatre octets par texel dont un seul sert) ; les palettes du décor sont quelques dizaines par vue. Le paquet principal passe de 787,3 à 1 195,8 ko (216,9 à 268,0 ko compressés), dont le module de l'atlas, en base64. Une texture des rôles à un seul canal et un atlas livré en fichier binaire restent possibles (dernière section).

### 9. Le déterminisme

La pose est une fonction pure de la graine, de la case et des couches, sans `Math.random` ni fonction de `Math` dont le résultat varie ; les états de saison passent par `seasonFactor` et `coverShare` (dmath). Rien n'entre dans l'état de la simulation : le worker charge les nouvelles données sans les lire, `src/sim` n'est pas touché, `src/worldgen/resources.ts` ne fait que partager `FLORA_VARIATION` et le code des densités, et les empreintes de référence de `src/sim/state.test.ts` (f363d517, 567d06a4 et cd841d8f) ne bougent pas. L'empreinte de toute la pose d'un monde Petit (pixelciv : f0f3aeca) est la même quel que soit l'ordre des blocs ; celle de l'atlas du décor est figée (2b2e5988).

### 10. Les tests

Chacun échoue quand on retire ce qu'il protège (mutations : 13 sur la pose, 27 sur le rendu, toutes détectées).

- **Données** (`src/core/data/data.test.ts`) : chaque valeur hors bornes refusée, rampe de trois tons, caduc sans automne ou sans forme nue ni tons d'hiver, persistant aux tons d'automne, sec sans tons secs, mois en double, biome, minerai ou occupation inconnus.
- **Pose et saisons** (`src/gen/decor.test.ts`) : sur trois mondes Petits, au plus un objet de chaque sorte par case, rien sur l'eau ni sur une rivière ; poids des espèces ; couture et copies du monde ; empreinte indépendante de l'ordre des blocs ; occupation du sol ; `floraDensity` sans effet hors pinceau ; feuillé, automne, nu et sec au nord et au sud ; caduc d'un hiver doux ; neige au seuil ; fruits à leurs mois ; aucun buisson caduc vert ni fruité en janvier au nord, hors des fruits que les données gardent l'hiver.
- **Légendes et atlas** (`src/gen/legend.test.ts`, `tools/decor-atlas.test.ts`) : codage des rôles, erreur qui nomme grille et ligne, grille du gibier refusée avec la légende du décor, pieds sur la dernière rangée, ombre seulement sous les pieds et jamais sur le motif, largeur de l'atlas des humains, empreinte.
- **Rendu** (`src/render/decor.test.ts`, `objects.test.ts`, `seasons.test.ts`, `humanShader.test.ts`, `people.test.ts`) : chaque rôle de chaque motif colorié par les données dans chaque état ; collecte au pixel de la pose, couture, collecte gardée, palettes une fois par clé, cache borné et pinceau ; codes et part de neige égaux à ceux du shader de la carte ; tri commun, un conteneur et une texture, appui, décor sans foule, rien de loin, signature, alpha prémultiplié, drapeaux, sol de l'ombre M3.
- **GPU** : le contrôle des pixels de Chromium (`tools/human-control/`) compare aussi les objets : 3,4 millions de pixels sur cinq vues, dont 2,7 millions d'objets, aucun écart.
- **Crédits** : `tools/credits.test.ts` reconnaît le finaliseur de MurmurHash3 à ses constantes, et refuse lowbias32, non crédité ; `CREDITS.md` cite `src/gen/decor.ts` à la ligne de SplitMix, et `src/render/humanShader.ts` à celle de Bayer.

## Conséquences

- La carte montre de près forêts, bosquets, buissons et rochers, aux couleurs de la saison et sous la neige, et les humains y passent devant et derrière les arbres ; de loin, rien ne change.
- Un nouveau contenu de flore demande une grille et une rampe de données, et aucun code ; un nouveau minerai, une entrée de `deposits` ; une occupation du sol, une entrée de `landUse`.
- Les humains sont plus souvent cachés : dans une forêt dense, un houppier couvre le haut de ceux qui sont derrière lui ; l'appui ouvre alors la case.
- Le coût du calque croît avec le décor visible, au pire au zoom 3 sur un grand écran tout en forêt ; la pose d'un bloc, au premier regard, coûte quelques millisecondes.

## Écarts avec la conception et la critique

- **Requis de la critique, appliqués** : hachages par `splitmix32` et `streamSeed`, crédités ; pose et saisons dans `src/gen` ; `FLORA_VARIATION` et `FOREST_SNOW_SHARE` partagés, neige lue des codes de la texture des saisons et testée contre `COVER_GLSL` ; neige donnée en entrée de `decorSeason`, et exigence sur 2b.7 (§ 5) ; buissons caducs, tons d'hiver, fruits à leurs mois ; D10 cité, M3 ajoutée et retenue par défaut, M1 gardée au choix des données ; occupation du sol en entrée de la pose et invalidation par bloc ; une légende par atlas, et pas d'ombre pour le gibier.
- **Facultatifs appliqués** : collecte en coordonnées de carte, par carrés, états refaits au seul changement de jour ; poids des espèces ; « on touche ce qu'on voit » ; deux tickets (le décor, puis le gibier) ; base et dépendance écrites ; réglage des effets annoncé ; mutations ; clés de palettes denses ; écran de PC à la densité 2 mesuré.
- **Facultatif écarté en partie** : les atlas restent dans le paquet JavaScript, en base64, et la texture des rôles garde quatre octets par texel ; seul le rangement plus serré est fait (275 rangées au lieu de 333). Un fichier binaire et une texture à un seul canal toucheraient la chaîne des humains de 2b.5 et le chargement du jeu ; le gain, 371 Kio de base64 à ne plus lire ni décoder et 1,2 Mio de texture, est à peser sur un vrai téléphone, que l'auteur essaiera.
- **Écarts avec le plan de la conception** : pas de colonne `kind` dans `CrowdLayout`, les objets ne passant pas par la disposition ; 64 blocs en cache au lieu de 96, assez pour un écran de 2 560 × 1 440 à la densité 2 ; la clé de graine sous le nom `gen.decor` ; 42 grilles au lieu de 45 (plus de forme générique « bush »).

## Ce qui reste à décider par l'auteur

1. **La taille des arbres** : 1,6 à 1,7 fois l'adulte, un peu plus d'une case ; plus petits, ils cacheraient moins les humains, mais la forêt dense, à un arbre par case, se clairsèmerait.
2. **La densité** : le décor a celle des individus (ADR 0014 § 6), si bien qu'un arbre au pixel fin se pose sur des pixels de carte 3 à 21 fois plus gros, comme les humains (ADR 0016, point 10).
3. **« Case de forêt »** : lue comme toute case de terre, la densité de la couche décidant, et non la tuile ; au plus un arbre par case partout.
4. **Les gisements en mode naturel** : (a) rochers au minerai visible, comme aujourd'hui ; (b) rochers nus, qui disent où mais pas quoi ; (c) aucun rocher pour les gisements. Le choix se fait par minerai dans `data/decor.json` ; la voie (c) contredit la consigne, qui demande des objets posés d'après les gisements.
5. **Les rochers épars** des biomes de la tuile `rock`, que la consigne ne nomme pas ; une probabilité par biome, qui peut être nulle.
6. **Rien sur les rivières et les fleuves**, dont les cases restent ouvertes ; les ruisseaux gardent leurs objets.
7. **Le pinceau** : la densité est ramenée dans l'étendue du nouveau biome au rendu, sans toucher la simulation ; l'autre voie est de récrire les couches dans l'état (protocole et sauvegarde).
8. **L'ombre** : M3 (`ground`), retenue d'après C1 (D10), fidèle aux palettes mais discrète sur un sol de forêt, et qui peint du ton de la terre un ruisseau dans l'ombre ; M1, un noir translucide, visible partout mais hors palette (+ 47 % de couleurs sur une forêt) ; ou une trame au ton du contour. Planches côte à côte jointes à la PR.
9. **Les saisons** : seuils de température (nu sous 5 °C, automne sous 12 °C en refroidissant), caducs toujours feuillés sous un hiver doux, pas de printemps distinct (2b.7), saison sèche pour les seuls acacias et broussailles ; un arbre s'enneige d'un coup, quand un peu plus du tiers de sa case est blanche ; massettes des roseaux gardées l'hiver.
10. **Les poids des espèces** par biome, et les rampes de couleurs de `flora.json` et `decor.json`, à juger sur les captures.
11. **Les zooms 1 et 2 sans décor** : les forêts n'y sont que les tuiles cuites ; au zoom 3, les arbres paraissent d'un coup, avec les humains.
12. **Les dessins** : tracés par un script puis retouchés, à juger sur les captures ; AST-03 dit la flore « générée » : lue comme « faite pour le jeu », les grilles restant les sources éditables d'AST-04.
13. **Le décor seulement en mode naturel**, et pas choisi par l'appui, qui ouvre la case quand un houppier cache un humain.
14. **Sur un vrai téléphone** : le coût du GPU (de 1,5 à 3 fois la surface de l'écran en motifs), celui du fil principal au zoom 3, et la pose d'un bloc au premier regard, à mesurer ; puis le choix d'un atlas binaire et d'une texture des rôles à un canal.
15. **`docs/BACKLOG.md`** disait « animaux à intégrer en 2b.6 » : le gibier sera dessiné de zéro dans le style des planches de `sprites/animals/`, qui ne s'intègrent pas, faute de titre, d'auteur et de lien pour les créditer ; la ligne est corrigée.
