# Grilles du gibier

Les sources du gibier (tâche 2b.6, ADR 0018) : le cerf, la biche, le sanglier et le lièvre, de profil, en grilles de texte éditables à la main, un caractère par pixel (AST-04). Un caractère désigne un **rôle de teinte** et non une couleur : le jeu pose sur chaque rôle un ton de `data/fauna.json`, selon l'espèce (REN-09). Ce sont des dessins originaux du jeu, faits dans le style des animaux de `sprites/animals/` (contour sombre, peu de couleurs, vus de profil) : aucun pixel n'y vient de ces planches, qu'on ne pourrait pas créditer.

Au build, et au lancement du serveur de développement, `tools/fauna-atlas.ts` lit toutes les grilles de ce dossier, en tire les cinq niveaux de motifs des humains (`data/humans.json`, réduction par vote), et, pour le jeune de chaque espèce, les mêmes niveaux d'une réduction de plus (`look.young` de `data/fauna.json`). Il range le tout dans un atlas de rôles que le jeu reçoit par le module `virtual:fauna-atlas`, et qu'il pose sous ceux des humains et du décor, dans la même texture.

## Format

- Le fichier `<forme>-<animation>.txt` donne l'animation `animation` (`idle`, `walk`, `run`, `fall`) de la forme `forme`, que nomme `data/fauna.json` (`look.form`, `look.male`). Le build échoue si une forme nommée n'a pas ses quatre animations, ou si une animation n'a pas, d'une forme à l'autre, le même nombre d'images.
- En tête, `# légende fauna` : la légende du gibier. Une grille du décor est refusée, et une grille du gibier l'est par l'atlas du décor, même si leurs caractères ont un sens dans l'autre légende.
- `# pieds N` : la colonne des pieds, comptée de 0 depuis la gauche, la même pour toutes les images de la grille.
- Puis les images, chacune ouverte par `# image k`, `k` de 0 à n − 1 dans l'ordre, toutes de même taille. Les pieds se posent sur la **dernière rangée** de l'image, la ligne du sol : un animal au galop ou qui bondit la quitte, mais une image au moins de la grille s'y pose.
- Des lignes de même longueur ; une ligne vide, ou qui commence par `#`, est un commentaire. Les erreurs numérotent les lignes comme le fichier.
- La tête regarde l'**ouest**, comme les humains des planches ; le jeu retourne le motif pour l'animal qui va vers l'est.
- La taille est celle de la planche des humains, dont l'adulte mesure 43 rangées : la biche en fait 43, le cerf 50 avec ses bois, le sanglier 28, le lièvre 18.
- **Pas d'ombre portée** : le gibier n'en a pas, comme les humains.

| Caractères | Rôle | Couleur |
|---|---|---|
| `.` | transparent | |
| `o` | contour | `rules.outline` de `data/fauna.json` |
| `C` `c` `v` `V` | pelage : lumière, base, ombre, ombre profonde | `look.coat` de l'espèce |
| `P` `p` `q` `Q` | parties claires : ventre, gorge, miroir, groin, queue | `look.pale` |
| `D` `d` `e` `E` | parties sombres : sabots, crinière, bouts d'oreille ; `E` est l'œil, que la réduction garde d'un pixel | `look.dark` |
| `H` `h` `j` `J` | bois du cerf, défenses du sanglier | `look.horn`, que demande toute forme qui en dessine |

## Animations

- `idle` : debout, un coup d'oreille ou de queue, puis l'animal broute, tête basse (deux images) ; le jeu en tire un cycle, `rules.idle` de `data/fauna.json`.
- `walk` : quatre images, deux pas du rendu par cycle (`rules.cadence.walk`).
- `run` : le galop, ou les bonds du lièvre ; la fuite est la course (`rules.cadence.run`).
- `fall` : l'animal trébuche, puis il est couché : le jeu le montre ainsi quand il meurt (vieillesse, excès sur la cible), et la chasse de 2b.8 s'en servira.

## Contenu

Les grilles ont été tracées par un script à la conception de 2b.6 (tronc entre une ligne du dos et une ligne du ventre, cou, tête, oreilles, queue, pattes de deux segments à largeur exacte, sabots sombres, pattes lointaines un rang plus sombres, contour autour de la silhouette), puis restent retouchables à la main. Formes : `deer` (la biche, et le jeune cerf), `stag` (le cerf de deux ans et plus, ses bois d'un pixel), `boar` (crinière sombre, défense, groin clair), `hare` (oreilles à bout noir, queue blanche).
