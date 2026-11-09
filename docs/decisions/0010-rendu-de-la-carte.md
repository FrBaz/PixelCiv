# ADR 0010 — Rendu de la carte

Statut : accepté · 9 novembre 2026 · tâches 1.7 et 1.8

## Contexte

La carte se dessine en tuiles de 4 px par case (REN-01), par blocs de 64 × 64 cases que l'on ne recuit que s'ils changent (REN-02). Le relief se lit par un léger débordement des cases hautes sur les plus basses et par un éclairage selon la pente. Les saisons passent par un shader qui lit une texture de données, une valeur par case, sans recuire les blocs (REN-10, C1 D10) ; elles recolorent par palettes de saison propres à chaque biome, sans mélange libre de couleurs. Le plan vise 60 images/s sur PC et 30 sur téléphone, sur une carte Grand (tâche 1.8).

## Décision

- **Cuisson dans des workers.** `src/render/bake.ts` cuit un bloc en pixels RGBA, en fonction pure, sans PixiJS. Un ou deux workers de cuisson (`bakeWorker.ts`), selon les cœurs de l'appareil, reçoivent une copie des couches du monde ; le répartiteur (`baker.ts`) leur confie les blocs visibles d'abord, du centre de l'écran vers les bords. Un bloc changé par la simulation est recuit avec ses huit voisins, car débordement et rivières passent d'un bloc à l'autre.
- **Tuiles.** Chaque biome a un motif (`tile` dans `data/biomes.json`) : herbe, forêt, sable, roche, glace, marais, eau. Le motif choisit, pixel par pixel, l'ombre, la base ou la lumière de la palette du biome, par un hachage du pixel du monde. L'eau prend trois teintes selon sa profondeur, tramées par une matrice de Bayer, avec quelques reflets. Les tirages ne dépendent que des coordonnées du pixel dans le monde, x bouclé : deux blocs voisins se raccordent au pixel près, y compris à la couture.
- **Débordement.** Le pixel de bord d'une case prend la tuile d'une voisine plus haute, avec une probabilité qui croît avec l'écart d'altitude ; une terre déborde sur l'eau une fois sur deux, ce qui découpe les côtes. Les plus grands écarts débordent d'un second pixel.
- **Ombrage.** Le relief est interpolé au pixel entre les centres des cases, l'altitude élevée à la puissance 0,6 pour que les plaines gardent leurs ondulations, et la surface de l'eau plate. La pente, sous une lumière du nord-est, multiplie la couleur de 0,55 à 1,45. Une teinte thermique réchauffe les terres chaudes et bleuit les froides.
- **Rivières.** Chaque case de rivière trace un segment vers sa case aval, large de 1 à 3 pixels selon sa classe ; une rivière qui finit sous un glacier s'arrête à son bord.
- **Données dans l'alpha.** Les blocs sont opaques : leur canal alpha porte des données pour le shader. Le bit 7 distingue la terre (1) de l'eau (0), les 7 autres codent l'ombrage. Les textures sont donc chargées sans prémultiplication.
- **Texture des saisons.** Un texel par case (`seasons.ts`) : température annuelle, demi-amplitude, hémisphère, végétation, couverture (neige, glace, banquise) et biome. Une texture de palettes donne, pour chaque biome, les trois tons de sa couverture (`seasons` dans `data/biomes.json`).
- **Shader.** Un maillage par bloc visible, sous `mapShader.ts`. Le shader calcule la température du mois, en continu d'un mois à l'autre, et pose la couverture selon les seuils de C1 (D9) : neige sous 0,5 °C sur les terres (moins en forêt), glace sous −1 °C sur l'eau douce (rivières comprises), banquise sous −6 °C sur la mer côtière. Une couverture partielle se trame par Bayer ; le pixel couvert prend l'un des trois tons de la palette, selon son ombrage. De près, la trame suit les pixels ; de loin, les cases, pour ne pas scintiller au défilement.
- **Modes de carte.** Relief, biomes et ressources remplacent la couleur par celle d'une texture de superposition, une valeur par case, calculée à la demande (`mapModes.ts`), en gardant l'ombrage ; le mode « ressources » pâlit la carte et colore les gisements.
- **Niveau de détail de base.** Les textures des blocs ont leurs mipmaps, filtrés au plus proche : sous le zoom 1, chaque pixel de l'écran lit le niveau qui lui correspond, sans scintiller.

## Conséquences

- Le monde existe en trois copies sur l'appareil : celle de la simulation, celle du fil principal et celle de chaque worker de cuisson, de l'ordre de 6 Mo chacune pour un monde Grand.
- Les blocs d'un monde Grand occupent 32 Mo de mémoire graphique, plus un tiers pour les mipmaps. Le rendu entièrement sur la carte graphique, prévu en réserve par le plan, reste possible : la texture des saisons en est le premier pas.
- Changer un biome en cours de partie recuit neuf blocs, et recharge la texture des saisons.
