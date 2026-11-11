# Sources pixel art

Les sources pixel art du jeu (AST-03, AST-04) : des grilles de texte, éditables à la main, un caractère par pixel. Un caractère désigne un **rôle de teinte**, et non une couleur : le jeu recolore chaque motif à l'exécution (REN-09). Un même motif sert ainsi à tous les teints, à toutes les couleurs de cheveux et à tous les habits.

Au build, et au lancement du serveur de développement, `tools/pixel-atlas.ts` lit toutes les sources de ce dossier et les range dans un seul atlas, que le jeu reçoit par le module `virtual:pixel-atlas`. Une source ajoutée, modifiée ou supprimée change l'atlas au build suivant ; en développement, l'atlas se refait et la page se recharge.

## Format

- Des lignes de même longueur ; une ligne vide, ou qui commence par `#`, est ignorée. Les messages d'erreur numérotent les lignes comme le fichier, commentaires compris.
- Le texte est en UTF-8 ; une marque d'ordre des octets (BOM) en tête est ignorée.
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

- `sprites/` : mini-sprites de la carte (REN-04), de 6 à 10 pixels de haut, à la densité de pixels de la carte (REN-08) : nourrisson de 4 × 6, enfant de 4 × 7, adulte de 6 × 9. Deux images par classe d'âge, pour la marche, de même taille ; les adultes ont un motif par sexe, le nourrisson et l'enfant un seul.
- `icons/` : icônes de la carte, comme la bannière d'un groupe vu de loin (`icons/group`), aux couleurs de l'habit de sa culture. Quand l'échelle de la carte le permet, l'icône est à la densité de la carte, un pixel d'icône par pixel de carte ; plus loin, elle devient un marqueur d'interface, à 2 pixels CSS par pixel d'icône, arrondis en pixels physiques entiers (`src/render/crowd.ts`).
