# Grilles du décor

Les sources du décor en objets (tâche 2b.6, ADR 0017) : arbres, conifères, buissons et rochers, en grilles de texte éditables à la main, un caractère par pixel (AST-04). Un caractère désigne un **rôle de teinte** et non une couleur : le jeu pose sur chaque rôle un ton de `data/flora.json` ou de `data/decor.json`, selon l'espèce, la saison et la neige (REN-09). Ce sont des dessins originaux du jeu : aucun pixel n'y vient d'un pack.

Au build, et au lancement du serveur de développement, `tools/decor-atlas.ts` lit toutes les grilles de ce dossier, en tire les cinq niveaux de motifs des humains (`data/humans.json`, réduction par vote), ajoute à chaque niveau l'ombre portée, et range le tout dans un atlas de rôles que le jeu reçoit par le module `virtual:decor-atlas`. Une grille ajoutée, modifiée ou supprimée change l'atlas au build suivant ; en développement, l'atlas se refait et la page se recharge.

## Format

- Le fichier `<forme>-<variante>.txt` donne la variante `variante` (0, 1, 2…, sans trou) de la forme `forme`, que nomment `data/flora.json` (`look.form`, `look.bare`) et `data/decor.json` (`deposits`, et `rock` pour les rochers épars). Le build échoue si une forme nommée n'a pas de grilles.
- En tête, `# légende decor` : la légende du décor, que chaque grille déclare. Une grille d'un autre atlas (le gibier a la sienne) est refusée, même si ses caractères ont un sens ici.
- `# pieds N` : la colonne des pieds, comptée de 0 depuis la gauche. Les pieds se posent sur la **dernière rangée**, qui a au moins un pixel : aucune rangée vide sous eux.
- Des lignes de même longueur ; une ligne vide, ou qui commence par `#`, est un commentaire. Les erreurs numérotent les lignes comme le fichier.
- La taille est celle de la planche des humains, dont l'adulte mesure 43 rangées : un feuillu en fait 68 à 73, un buisson 12 à 19. Les motifs ne se retournent pas : la lumière vient du nord-est (en haut à droite), comme sur l'ombrage de la carte.
- **Pas d'ombre portée dans les grilles** : le build la projette lui-même à chaque niveau, vers le sud-ouest, d'après `data/decor.json` (`shadow`).

| Caractères | Rôle | Couleur |
|---|---|---|
| `.` | transparent | |
| `o` | contour | `outline` de `data/decor.json` |
| `F` `f` `g` `G` | feuillage : lumière, base, ombre, ombre profonde | la rampe de l'état de l'espèce : été, automne, hiver ou saison sèche |
| `W` `w` `v` `V` | bois | `wood` de l'espèce |
| `S` `s` `z` `Z` | neige | sous la neige, la palette de couverture du biome et le ton profond de `snow.deep` ; sinon, ce qu'elle recouvre : le feuillage, le bois d'une forme nue, la pierre d'un rocher |
| `P` `p` `q` `Q` | fruit (baies, fleurs, noix, massettes) | `fruit.tones` de l'espèce, pendant ses mois ; le feuillage sinon |
| `R` `r` `k` `K` | pierre | `stone` de `data/decor.json` |
| `U` `u` `n` `N` | minerai | `ore` du gisement ; la pierre pour une roche nue |
| `C` `c` `j` `J` | chaperon : le dessus du contour | le contour hors neige, la neige sous la neige |

## Neige et chaperon

La neige est une région peinte dans la silhouette, là où elle tiendrait : le dessus des touffes et des étages, le haut des branches. Hors neige, elle prend les tons de ce qu'elle recouvre, si bien qu'une grille n'a pas à changer pour l'hiver. Le chaperon est la part du contour qui borde le haut d'une forme : sombre comme le contour toute l'année, il blanchit sous la neige.

## Contenu

Les grilles ont été tracées par des scripts (formes simples, éclairage du nord-est, touffes ombrées) à la conception et à la réalisation de 2b.6, puis restent retouchables à la main. Formes : `broadleaf`, `birch`, `conifer` (aussi le mélèze en été), `palm`, `tropical-hardwood`, `acacia`, `mangrove` ; nues : `broadleaf-bare`, `birch-bare`, `larch-bare` ; buissons : `berry-bush`, `scrub`, `dwarf-willow`, `heather`, `reed`, `cactus` ; rochers : `rock`, `ore-rock`, `salt-crust`.
