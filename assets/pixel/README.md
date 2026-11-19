# Sources pixel art

Les sources pixel art du jeu (AST-03, AST-04) : des grilles de texte, éditables à la main, un caractère par pixel. Un caractère désigne un **rôle de teinte**, et non une couleur : le jeu recolore chaque motif à l'exécution (REN-09). Un même motif sert ainsi à tous les teints, à toutes les couleurs de cheveux et à tous les habits.

Au build, et au lancement du serveur de développement, `tools/pixel-atlas.ts` lit toutes les sources de ce dossier et les range dans un seul atlas, que le jeu reçoit par le module `virtual:pixel-atlas`. Une source ajoutée, modifiée ou supprimée change l'atlas au build suivant ; en développement, l'atlas se refait et la page se recharge.

## Format

- Des lignes de même longueur ; une ligne vide, ou qui commence par `#`, est ignorée. Les messages d'erreur numérotent les lignes comme le fichier, commentaires compris.
- Le texte est en UTF-8 ; une marque d'ordre des octets (BOM) en tête est ignorée.
- Le fichier `dossier/nom.txt` donne le motif `dossier/nom`.
- Variantes de hauteur (ADR 0014) : une ligne `# variantes 8 à 10, rangée 7` demande les motifs `dossier/nom@8`, `dossier/nom@9` et `dossier/nom@10`, d'une rangée de moins, de la hauteur de la source et d'une rangée de plus. La rangée désignée, comptée de 1 depuis le haut du motif, y est ôtée ou doublée ; l'étendue va d'une rangée de moins à une de plus au plus, et comprend la hauteur de la source. Une forme inexacte, une rangée hors du motif ou une seconde demande lèvent une erreur qui nomme la ligne.

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

- `sprites/` : mini-sprites de la carte, de 6 à 9 pixels de haut, dans la plage de REN-04 (de 6 à 10) : nourrisson de 4 × 6, enfant de 4 × 7, adulte de 6 × 9, largeur × hauteur. Chacun se dessine à sa position, à la densité de pixels commune aux individus de la vue (ADR 0014). L'adulte se décline de 8 à 10 rangées, en doublant ou en ôtant sa rangée 7, et l'enfant de 6 à 8, par sa rangée 5 : la stature de chacun choisit sa variante, quel que soit le zoom ; le nourrisson n'en a qu'une. Le test de l'atlas (`tools/pixel-atlas.test.ts`) vérifie la plage de REN-04, ces variantes, et que le nourrisson est plus petit que l'enfant, l'enfant que l'adulte. Deux images par classe d'âge, pour la marche, de même taille ; les adultes ont un motif par sexe, le nourrisson et l'enfant un seul.
- `icons/` : icônes de la carte, comme la bannière d'un groupe vu de loin, aux couleurs de l'habit de sa culture. Comme les mini-sprites, elle est toujours à la densité de pixels de la carte (REN-08) : sa taille à l'écran passe par celle de son motif, et non par celle de ses pixels. Elle existe donc en quatre tailles, un même dessin de 8, 16, 24 et 36 pixels de haut (`icons/group`, de 7 × 8, puis `icons/group-16`, `icons/group-24` et `icons/group-36`), les plus grandes redessinées plus finement, et non agrandies ; le jeu prend la plus petite qui fasse au moins 12 pixels CSS de haut (`src/render/crowd.ts`). Toutes n'emploient que le contour, pour la hampe, et l'ombre, la base et la lumière de l'habit, pour le drapeau ; la hampe tient la colonne de gauche, de haut en bas, et son pied, le coin bas gauche, se plante sur la case. Le test des bannières (`src/render/crowd.test.ts`) vérifie ces tailles, ces rôles et cette hampe.
