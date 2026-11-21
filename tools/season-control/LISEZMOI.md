# Contrôle des pixels des couleurs de la saison

Vitest ne voit pas le shader de la carte. Les empreintes de `src/render/mapShader.test.ts` figent le code des saisons (`MAP_FRAGMENT_SEASONS`, `MAP_FRAGMENT_WAVES_SEASONS`), celle de `src/render/seasonMirror.test.ts` le motif de son miroir TypeScript sur la cuisson de blocs d'un monde Petit. Ce contrôle vérifie, dans Chromium, que le shader et son miroir décident de la même façon, pixel à pixel, sur la cuisson réelle et sa carte d'identité des tons (ADR 0019, § 8), et que le cran coupé du réglage des effets rend la carte d'avant le second temps de 2b.7 (ADR 0019, § 4 ; ADR 0020).

## Quand le lancer

Quand le code des saisons, son miroir ou la cuisson changent, c'est-à-dire quand l'une de leurs empreintes change : on ne met une empreinte à jour qu'après ce contrôle, et l'on joint son résultat à la PR.

Les palettes des états (`seasons.states` de `data/biomes.json`), la lumière d'hiver (`light` de `data/seasons.json`) et les seuils du feuillage (`foliage` de `data/decor.json`) n'en demandent aucun : le shader les reçoit par ses textures et ses uniformes, que le miroir lit dans les mêmes données.

## Ce qu'il faut

- Node et les dépendances du projet (`npm ci`).
- Playwright et son Chromium, qui ne sont pas des dépendances du projet : `capture.cjs` prend Playwright là où Node le trouve.
- Pour comparer le cran coupé à la carte d'avant, une construction du commit `e5b1f3f`, la fin du premier temps de 2b.7 (la neige et la glace à inertie).

## Commandes

Depuis la racine du dépôt, avec un dossier de travail `<d>` hors du dépôt, donné en chemin absolu :

```sh
# 1. Construire la copie de travail, puis e5b1f3f dans un sous-dossier (facultatif), et servir.
npx vite build --outDir <d>/dist --emptyOutDir
git worktree add --detach <d>/avant e5b1f3f
ln -s "$PWD/node_modules" <d>/avant/node_modules
(cd <d>/avant && npx vite build --outDir <d>/dist/before --emptyOutDir)
npx vite preview --outDir <d>/dist --port 4576 --strictPort &

# 2. Capturer les onze vues (environ neuf minutes).
node tools/season-control/capture.cjs http://localhost:4576/ <d>/captures http://localhost:4576/before/

# 3. Les comparer au miroir (une minute environ).
CONTROL_DIR=<d>/captures npx vitest run --mode season-control
```

Le serveur de `vite preview` relève les fichiers à son démarrage : relance-le après chaque construction. La troisième adresse de l'étape 2, facultative, est celle de la construction d'avant. `CONTROL_VIEWS=pixelciv-412-62-m9.5,autre-53-190-m4.2` ne capture que les vues nommées. Chaque vue a son dossier, `<graine>-<x>-<y>-m<mois>` : les captures PNG (`full.png`, `reduced.png`, `off.png`, `base.png`), `meta.json` (la caméra de chaque capture, les blocs dessinés par un programme des saisons) et, après l'étape 3, `result.json`.

## Les vues

Toutes sur un monde Petit, sur PC (1 280 × 720 pixels, densité 1), au zoom 1 : un pixel de l'écran est un pixel de carte ; les deux dernières au zoom 0,75, la branche de loin du code des saisons (une échelle sous 1), où chaque pixel de l'écran lit le niveau 0 des mipmaps, à un pixel de carte près. La partie est en pause dès sa création, le mois est forcé par `?month=`, la mer immobile (`?waves=off`), le cran fixé par `?effects=`, l'interface masquée.

| Vue | Case visée | Mois | Ce qu'elle montre |
|---|---|---|---|
| `pixelciv-412-62-m9.5` | (412, 62) | 9,5 | forêts du nord à l'automne, toundra en dormance, neige |
| `pixelciv-412-62-m0.5` | (412, 62) | 0,5 | bois nus, herbes en dormance, lumière d'hiver, neige et glace |
| `pixelciv-412-62-m3.6` | (412, 62) | 3,6 | le retour du vert, la neige qui reste |
| `pixelciv-412-62-m6.5` | (412, 62) | 6,5 | le cœur de l'été du nord : rien ne change |
| `pixelciv-330-190-m9.5` | (330, 190) | 9,5 | le printemps du sud |
| `graine-308-47-m9.8` | (308, 47) | 9,8 | forêts du nord à l'automne |
| `graine-303-150-m1.5` | (303, 150) | 1,5 | saison sèche des tropiques, été du sud |
| `autre-235-33-m10.5` | (235, 33) | 10,5 | toundra et taïga, lumière d'hiver |
| `autre-53-190-m4.2` | (53, 190) | 4,2 | automne du sud |
| `graine-308-47-m9.8-z0.75` | (308, 47) | 9,8 | de loin, au zoom 0,75 : rivières et côtes de l'automne |
| `pixelciv-412-62-m9.8-z0.75` | (412, 62) | 9,8 | de loin, au zoom 0,75 : le lac, ses rives et les rivières |

## Résultat attendu

Le contrôle échoue au moindre écart au-delà d'une unité. Pour chaque vue :

- `offVersusBase.differ` : 0, si la construction d'avant a été capturée. Le cran coupé rend sa carte octet pour octet, neige et glace comprises. **Ce n'est plus vrai depuis la fonte lente de la relecture (f6e1dbb)** : à la fonte de chaque hémisphère, la neige et la glace du cran coupé diffèrent de celles de e5b1f3f (à la publication de 2b.7, 45 215 pixels sur les onze vues, tous des tons de neige ou de glace, et le contrôle échoue sur six vues) ; hors de la neige et de la glace, le cran coupé rend 7c893a7 au pixel près (79 905 pixels de neige ou de glace en diffèrent, aucun autre). Classer ces écarts plutôt qu'attendre 0 est soumis à l'auteur.
- `far` : 0. Chaque pixel des crans plein et atténué vaut ce que dit le miroir, à une unité près sur un canal : le ton de même rang d'une palette déclarée, sous l'ombrage et la teinte de la cuisson, ou le pixel du cran coupé.
- `mismatch` : rare (au plus 0,5 % des pixels changés). Ce sont les produits qui tombent sur une demie, que le GPU et le miroir arrondissent chacun de son côté.
- Vues de loin (`-z0.75`) : `waterChanged` et `blueChanged` à 0 (aucun pixel changé ne vient d'une case sans tons de terre, eau, rivière ou rive, ni n'est bleu au cran coupé), et `matched` égal à `changed` à 1 % près (chaque pixel changé vaut le miroir de loin, `seasonFarPixel`, pour l'un des pixels de carte que la caméra situe à un pixel près).
- `reducedLight` : 0. Le cran atténué ne montre jamais la lumière d'hiver.
- `changed` : non nul, sauf au cœur de l'été (`pixelciv-412-62-m6.5`), où il doit valoir 0 sur les terres du nord : la carte y est celle de ses tuiles.
