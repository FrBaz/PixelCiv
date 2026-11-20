# Contrôle des pixels des humains

Vitest ne voit pas le shader des humains (`src/render/humanShader.ts`). Les tests le gardent hors du GPU : `humanShader.test.ts` évalue, en flottants de 32 bits, les expressions GLSL de l'adressage des palettes (`PALETTE_ADDRESS`), que le shader assemble, contre `slotColor` et `paletteTexel` ; `people.test.ts` vérifie, sur un faux rendu WebGL, que le calque pose le shader, envoie les palettes au GPU et fait suivre au shader la texture qui double. Ce contrôle vérifie, dans Chromium, que le GPU peint bien chaque pixel des humains, et des objets du décor et du gibier qui partagent leur calque, de la couleur de son rôle dans sa palette (ADR 0016, § 9 ; ADR 0017, § 7 ; ADR 0018).

## Quand le lancer

Quand le shader des humains, la texture des palettes, l'atlas des rôles ou la façon dont le calque pose ses particules changent (`src/render/humanShader.ts`, `src/render/people.ts`, `src/render/decor.ts`, `src/render/fauna.ts`, `tools/human-atlas.ts`, `tools/decor-atlas.ts`, `tools/fauna-atlas.ts`), et l'on joint son résultat à la PR. Une retouche des grilles, des tenues ou des palettes n'en demande aucun : elle change ce que l'atlas et les palettes contiennent, que le contrôle relit, et non la façon dont le GPU les lit.

## Ce qu'il faut

- Node et les dépendances du projet (`npm ci`).
- Playwright et son Chromium, qui ne sont pas des dépendances du projet. `capture.cjs` prend Playwright là où Node le trouve : une installation globale suffit.

## Commandes

Depuis la racine du dépôt, avec un dossier de travail `<d>` hors du dépôt, donné en chemin absolu :

```sh
# 1. Construire la copie de travail, et la servir.
npx vite build --outDir <d>/dist --emptyOutDir
npx vite preview --outDir <d>/dist --port 4557 --strictPort &

# 2. Capturer les cinq vues (environ une minute par vue).
node tools/human-control/capture.cjs http://localhost:4557/ <d>/captures

# 3. Les comparer à l'atlas des rôles et aux palettes (quelques secondes).
CONTROL_DIR=<d>/captures npx vitest run --mode human-control
```

`CONTROL_VIEWS=pc-z8,pixel5-z4` ne capture que les vues nommées. Chaque vue a son dossier : `meta.json` (les particules, dans l'ordre du dessin, avec leur cadre dans l'atlas des rôles, leur place, leur échelle et leur couleur ; la taille du tampon, la densité, les rangées de la texture des palettes), `frame.rgba` (le tampon WebGL, lu après un rendu, de haut en bas), `palettes.rgba` (la texture des palettes que le CPU a écrite) et, après l'étape 3, `result.json`.

## Les vues

Toutes sur un monde Petit, avec une foule de débogage (`?crowd=`) : la partie avance quatre secondes, pour que des individus marchent et se retournent, puis se met en pause, et la page rend la scène.

| Vue       | Écran                     | Graine   | Zoom | Foule | Ce qu'elle montre                                    |
| --------- | ------------------------- | -------- | ---- | ----- | ---------------------------------------------------- |
| `pc-z8`   | PC 1 280 × 720, densité 1 | pixelciv | 8    | 4 000 | facteur 1,5, k = 1, plus de 256 apparences            |
| `pc-z4`   | PC                        | graine   | 4    | 2 000 | facteur 3, sans contour                              |
| `pc-z24`  | PC                        | pixelciv | 24   | 600   | la planche, k = 2                                    |
| `pixel5-z4` | Pixel 5, densité 2,75   | pixelciv | 4    | 2 000 | facteur 1,5, k = 1, plus de 256 apparences            |
| `pixel5-z8` | Pixel 5                 | pixelciv | 8    | 600   | la planche, k = 2                                    |

## Résultat attendu

Le contrôle échoue au moindre écart. Pour chaque vue :

- `mismatch` : 0. Chaque pixel que couvre une particule des humains, la dernière dessinée devant, vaut la couleur du rôle de son motif (l'atlas des rôles du build) dans la palette de sa place (le texel de `paletteTexel` dans `palettes.rgba`), à la densité k de la vue, retourné s'il le faut.
- `undeclared` : 0. Aucun rôle d'un motif n'est sans couleur dans sa palette.
- Le programme posé est celui des humains, l'atlas des rôles de la page est celui du build, et la page n'a écrit aucune erreur.
- `compared`, `flipped` et `maxSlot` : des pixels comparés, des particules retournées, et une place plus petite que ce que tient la texture.
- Le décor (tâche 2b.6, ADR 0017, § 7) : ses objets sont des particules du même conteneur, leurs motifs rangés sous ceux des humains dans la même texture des rôles (l'atlas de la page a la hauteur des deux), leurs palettes dans la même texture. Leurs pixels se comparent comme ceux des humains, dans l'ordre du dessin, au rôle lu dans l'atlas du décor du build ; ceux de leur ombre portée, que l'ombre « ground » peint du ton du sol, ne se comparent pas, et cachent ce qu'ils recouvrent. `objects` et `comparedObjects` : des objets et des pixels d'objets comparés. Les vues du tableau sont en mode naturel : le décor s'y montre.
- Le gibier (tâche 2b.6, ADR 0018) : ses motifs se rangent sous ceux du décor, dans la même texture (l'atlas de la page a la hauteur des trois), ses palettes dans la même texture, à ses clés. Il n'a pas d'ombre portée : tous ses pixels se comparent, au rôle lu dans l'atlas du gibier du build, retournés pour l'animal qui va vers l'est. Ils comptent dans `objects` et `comparedObjects`.

Sur l'ensemble des vues : une place au-delà de 255 et une texture des palettes doublée deux fois au moins, k = 1 et k = 2, les deux densités d'écran. Une mutation de l'adressage (l'octet haut de la place lu dans le bleu, les rangées figées à 16), un envoi des palettes oublié ou un shader qui ne suit plus la texture qui double y font des milliers d'écarts.

Chromium rend ici en logiciel (SwiftShader) : le contrôle dit si les pixels sont justes, rien des temps d'un vrai GPU.
