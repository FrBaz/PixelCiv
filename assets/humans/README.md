# Régions du corps des humains

Les humains de la carte sont tirés des planches de l'auteur, `sprites/humans/skin/Male Skin1.png`
et `Female Skin1.png` (pack « 2D Pixel Art Male and Female Character » de GandalfHardcore, voir
`CREDITS.md`), et habillés par substitution exacte des tons, région par région (tâche 2b.5,
ADR 0016). Ce dossier dit, pour chaque pixel de peau ou de sous-vêtement de chaque image, à
quelle région du corps il appartient. Les planches ne se modifient pas : seules ces grilles se
retouchent.

## Format

Une grille par sexe et par animation : `regions/<sexe>/<animation>.txt`, l'animation étant
celle de `data/humans.json` (`idle`, `walk`, `run`, `jump`, `fall`, `throw`, `death`).

```
# Régions du corps, female, animation idle (rangée 1 de la planche).
# case 33 21
# image 0
...............
.....ooooo.....
....oCCCCCo....
```

- `# case x0 y0` : le coin du bloc dans la case de 80 × 64 pixels, le même pour toutes les
  images du fichier ; hors du bloc, la case est transparente.
- `# image N` : le bloc de l'image N de la rangée, comptée de 0, une ligne par rangée de pixels.
- Une lettre par pixel :
  - `.` : transparent ;
  - `o` : un ton gardé tel quel (contour, yeux, lèvres, paupières, sourire) ;
  - une majuscule : la région d'un pixel de peau ou de sous-vêtement, d'après la table
    `regions` de `data/humans.json` :

| Lettre | Région       | Lettre | Région     |
| ------ | ------------ | ------ | ---------- |
| `C`    | cuir chevelu | `A`    | avant-bras |
| `V`    | visage       | `M`    | main       |
| `N`    | cou          | `H`    | bassin     |
| `E`    | épaules      | `U`    | cuisse     |
| `P`    | poitrine     | `J`    | jambe      |
| `T`    | ventre       | `S`    | pied       |
| `B`    | bras         |        |            |

Les deux bras, les deux jambes, et le membre caché derrière le corps portent la même lettre.
Le cuir chevelu prend les tons des cheveux : la figure porte des cheveux ras.

## Contrôles

Le build et les tests lisent chaque pixel des 90 images (`tools/human-atlas.ts`) : un `.` sur un
pixel opaque, un `o` sur un ton de peau, une lettre sur un ton gardé ou une lettre inconnue
font échouer le build, avec le fichier, l'image et le pixel en défaut. Cela garantit la
silhouette, pas la justesse des régions : `tools/human-regions.test.ts` en est la garde, image
par image, chaque écart justifié dans sa liste, et toute excuse qui ne sert plus refusée.

- **Les aires** : chaque membre garde à peu près son aire du repos (entre la moitié et le
  double, à un pixel près). Elles attrapent un membre entier compté ailleurs, comme le bras qui
  longe le torse compté dans le torse, mais pas une bande de quelques pixels.
- **Les jointures** : une région ne touche, sans contour entre elles, que des régions voisines
  dans le corps (le ventre ne touche pas la main, le pied ne touche pas la cuisse) ; une bande de
  ventre dans une main, ou un pixel de pied sur une cuisse, en sort.
- **Le torse** : un morceau de torse détaché du torse principal tient au cou, à un bras ou à une
  cuisse, ceux qu'un membre coupe en passant devant.
- **Les bouts des membres** : chaque main tient à un seul avant-bras, chaque pied à une seule
  jambe, et un avant-bras ne porte qu'une main, une jambe qu'un pied.
- **Le repos recopié** : là où une image recopie le repos, pixel et huit voisins compris, après
  recalage, elle en garde les régions ; là où elle en reprend la tête (même silhouette, traits sur
  ceux du repos ou sur son visage, comme les yeux clos de la mort), elle en garde la ligne des
  cheveux.

Chaque tenue doit couvrir toutes les régions où un corps montre le sous-vêtement des planches
(le build le vérifie).

## Retoucher une grille

1. Repérer l'image en défaut sur une planche en fausses couleurs : la figure à côté de ses
   régions, agrandie au plus proche.
2. Changer les lettres dans le bloc de l'image, sans toucher aux `o` ni aux `.`, qui recopient
   la silhouette de la planche.
3. Lancer `npx vitest run tools/human-regions.test.ts tools/human-atlas.test.ts` : l'empreinte de
   l'atlas change, et se met à jour dans le test, pour que la retouche se voie en revue.
