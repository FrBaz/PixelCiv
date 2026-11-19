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
font échouer le build, avec le fichier, l'image et le pixel en défaut. `tools/human-regions.test.ts`
compare l'aire de chaque membre, image par image, à celle du repos : un bras compté dans le torse
en sort, sauf écart justifié dans sa liste. Chaque tenue doit couvrir toutes les régions où un
corps montre le sous-vêtement des planches (le build le vérifie).

## Retoucher une grille

1. Repérer l'image en défaut sur une planche en fausses couleurs : la figure à côté de ses
   régions, agrandie au plus proche.
2. Changer les lettres dans le bloc de l'image, sans toucher aux `o` ni aux `.`, qui recopient
   la silhouette de la planche.
3. Lancer `npx vitest run tools/human-regions.test.ts tools/human-atlas.test.ts` : l'empreinte de
   l'atlas change, et se met à jour dans le test, pour que la retouche se voie en revue.
