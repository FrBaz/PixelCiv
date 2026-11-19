# Contrôle des pixels de la mer animée

Vitest ne voit pas le shader de la carte. Deux empreintes de `src/render/mapShader.test.ts` le figent : celle du code GLSL de l'onde (`MAP_FRAGMENT_WAVES`), et celle du motif de son miroir TypeScript (`src/render/waves.ts`) sur des eaux fictives. Ce contrôle vérifie, dans Chromium, que le shader et son miroir décident de la même façon, pixel à pixel, sur la cuisson réelle (ADR 0015, § 10).

## Quand le lancer

Seulement quand la logique du shader ou du miroir change, c'est-à-dire quand l'une des deux empreintes de `mapShader.test.ts` change : on ne met une empreinte à jour qu'après ce contrôle, et l'on joint son résultat à la PR.

Les réglages de la mer animée (`waves` dans `data/biomes.json`) n'en demandent aucun. Le shader ne les reçoit que par ses uniformes, que le miroir lit dans la même table, et les empreintes ne lisent pas les données.

## Ce qu'il faut

- Node et les dépendances du projet (`npm ci`).
- Playwright et son Chromium, qui ne sont pas des dépendances du projet. `capture.cjs` prend Playwright là où Node le trouve : une installation globale suffit.
- Pour comparer l'onde éteinte à la tâche 2b.3, une construction du commit `a6ce118`, la base de 2b.4.

## Commandes

Depuis la racine du dépôt, avec un dossier de travail `<d>` hors du dépôt, donné en chemin absolu :

```sh
# 1. Construire la copie de travail, puis 2b.3 dans un sous-dossier (facultatif), et servir.
npx vite build --outDir <d>/dist --emptyOutDir
git worktree add --detach <d>/b23 a6ce118
ln -s "$PWD/node_modules" <d>/b23/node_modules
(cd <d>/b23 && npx vite build --outDir <d>/dist/b23 --emptyOutDir)
npx vite preview --outDir <d>/dist --port 4547 --strictPort &

# 2. Capturer les six vues (environ deux minutes).
node tools/wave-control/capture.cjs http://localhost:4547/ <d>/captures http://localhost:4547/b23/

# 3. Les comparer au miroir (une vingtaine de secondes).
CONTROL_DIR=<d>/captures npx vitest run --mode wave-control
```

Le serveur de `vite preview` relève les fichiers à son démarrage : relance-le après chaque construction. La troisième adresse de l'étape 2, facultative, est celle de la construction de 2b.3. `CONTROL_VIEWS=pixelciv-m0,autre-m3.2` ne capture que les vues nommées. Chaque vue a son dossier, `<graine>-m<mois>` : les captures PNG, `meta.json` (caméra, phase de l'onde de chaque capture) et, après l'étape 3, `result.json`.

## Les vues

Toutes sur un monde Petit, sur PC (1 280 × 720 pixels, densité 1), au zoom 1 : un pixel de l'écran est un pixel de carte. La partie est en pause dès sa création, le mois est forcé par `?month=`, et l'interface est masquée.

| Vue | Graine | Centre (pixels de carte) | Mois | Ce qu'elle montre |
|---|---|---|---|---|
| `pixelciv-m0` | pixelciv | (40, 500) | 0 | la couture, comparée à 2b.3 |
| `pixelciv-m1.3` | pixelciv | (32, 360) | 1,3 | la couture, bord de banquise en calme partiel |
| `graine-m0` | graine | (2030, 500) | 0 | la couture, comparée à 2b.3 |
| `graine-m11.4` | graine | (1856, 620) | 11,4 | gel partiel au sud |
| `autre-m0` | autre | (20, 520) | 0 | la couture, comparée à 2b.3 |
| `autre-m3.2` | autre | (1888, 360) | 3,2 | rivières et lacs qui gèlent |

Pour chaque vue : une capture au repos, l'onde éteinte par le mouvement réduit émulé, puis huit pas successifs de l'onde, menés par l'horloge de Playwright. La phase de chaque capture est lue dans les uniformes du shader.

## Résultat attendu

Le contrôle échoue au moindre écart. Pour chaque vue :

- `mismatch` : 0. Chaque pixel de chaque pas vaut ce que dit le miroir, le ton que l'onde lui donne ou sa couleur au repos.
- `restMismatch` : 0. Au repos, l'eau libre montre sa couleur cuite, donc la capture et la cuisson se superposent.
- `offVersusBase.differ` : 0 pour les vues du mois 0, si 2b.3 a été capturée. L'onde éteinte égale 2b.3.
- `moved` et `partial` : non nuls. Ils comptent les pixels que le miroir fait bouger et ceux qu'il compare en calme partiel, pour qu'une vue sans mer ni gel ne passe pas pour un succès.

Dernier passage, relecture de 2b.4 (empreintes `01c90fa3` et `5a74a6e6`) :

- 0 écart sur 44 236 800 pixels comparés ;
- 73 832 pixels changés par l'onde, un nombre qui suit les pas capturés et varie d'un passage à l'autre, et 56 712 pixels comparés en calme partiel ;
- l'onde éteinte égale 2b.3 sur 3 × 921 600 pixels.

Le même contrôle, sur un shader dont la crête était décalée d'un pixel, a compté 18 853 écarts sur une seule vue.

Chromium rend ici en logiciel (SwiftShader), ce qui suffit pour comparer des pixels, pas pour mesurer des temps.
