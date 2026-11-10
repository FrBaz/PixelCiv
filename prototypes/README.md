# Prototypes

Notebooks et scripts Python d'exploration. Ils illustrent des idées et servent de référence d'implémentation, mais ne font pas foi : en cas d'écart, le PRD et les documents validés de `docs/design/` l'emportent (CLAUDE.md, section « Méthode »).

Ils ne font pas partie du jeu : ni le build ni l'intégration continue ne les exécutent, et les règles du code du jeu (déterminisme, textes, contenu en données) ne s'y appliquent pas.

| Fichier | Sujet | Rôle | État |
|---|---|---|---|
| `testMap_filtre.ipynb` | Génération et rendu de la carte | Simple illustration : la phase 1 conçoit sa génération et son rendu à neuf, d'après C1 et les images de `docs/design/C1/` | non reçu |
| `testArmoiries.ipynb` | Armoiries | Simple illustration : les armoiries sont conçues à neuf | non reçu |
| `testVisages.ipynb` | Portraits | Simple illustration : les portraits sont conçus à neuf | non reçu |
| `c1/lacs_cotes_zones_humides.py` | Lacs, côtes et zones humides | Implémentation de référence de la séance C1, à insérer dans le pipeline du notebook | versé |
| `c1/saisons.py` | Températures mensuelles et recoloration saisonnière | Implémentation de référence de la séance C1 | versé |
| `c2/villages.py` | Score d'emplacement, fondations, croissance des villages et colonies | Implémentation de référence de la séance C2, pour la phase 3 | versé |
| `c2/territoires.py` | Routes au moindre coût et territoires organiques | Implémentation de référence de la séance C2, pour la phase 3 | versé |

Les sorties utiles à la lecture (cartes, graphiques) peuvent rester dans les notebooks. Les données lourdes ou recalculables n'ont pas leur place dans le dépôt.

Les deux scripts de C1 sont versés tels quels. Ils lisent des variables du notebook `testMap_filtre.ipynb`, qui ne s'exécute donc pas sans lui ; l'auteur les fournit à titre d'idée, et le jeu fait mieux s'il le peut.

Les deux scripts de C2 sont versés tels quels aussi. `villages.py` lit les couches produites par les scripts de C1 (`c1_masks.pkl`, `c1_apres.png`), et `territoires.py` rejoue `villages.py` : ils ne s'exécutent pas sans ces fichiers.
