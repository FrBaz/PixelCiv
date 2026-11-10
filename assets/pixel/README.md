# Sources pixel art

Les sources pixel art du jeu (AST-03, AST-04) : des grilles de texte, éditables à la main, un caractère par pixel. Un caractère désigne un **rôle de teinte**, et non une couleur : le jeu recolore chaque motif à l'exécution (REN-09). Un même motif sert ainsi à tous les teints, à toutes les couleurs de cheveux et à tous les habits.

Au build, et au lancement du serveur de développement, `tools/pixel-atlas.ts` lit toutes les sources de ce dossier et les range dans un seul atlas, que le jeu reçoit par le module `virtual:pixel-atlas`. Une source modifiée change l'atlas au build suivant ; en développement, la page se recharge.

## Format

- Des lignes de même longueur ; une ligne vide, ou qui commence par `#`, est ignorée.
- Le fichier `dossier/nom.txt` donne le motif `dossier/nom`.

| Caractère | Rôle |
|---|---|
| `.` | transparent |
| `o` | contour, pieds |
| `S`, `s`, `z` | peau : ombre, base, lumière |
| `H`, `h`, `y` | cheveux : ombre, base, lumière |
| `C`, `c`, `x` | vêtement : ombre, base, lumière |
| `e` | iris |
| `w` | blanc (œil, dents) |
| `m` | bouche |

## Contenu

- `sprites/` : mini-sprites de la carte (REN-04), de 4 à 9 pixels de haut, à la densité de pixels de la carte (REN-08). Deux images par âge et par sexe, pour la marche.
