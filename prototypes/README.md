# Prototypes

Notebooks et scripts Python d'exploration. Ils illustrent des idées et servent de référence d'implémentation, mais ne font pas foi : en cas d'écart, le PRD et les documents validés de `docs/design/` l'emportent (CLAUDE.md, section « Méthode »).

Ils ne font pas partie du jeu : ni le build ni l'intégration continue ne les exécutent, et les règles du code du jeu (déterminisme, textes, contenu en données) ne s'y appliquent pas.

| Fichier | Sujet | Rôle | État |
|---|---|---|---|
| `testMap_filtre.ipynb` | Génération et rendu de la carte | Pipeline que la phase 1 porte en TypeScript, corrigé par les décisions de C1 (PLAN, section 6) | à fournir |
| `testArmoiries.ipynb` | Armoiries | Simple illustration : les armoiries sont conçues à neuf | à fournir |
| `testVisages.ipynb` | Portraits | Simple illustration : les portraits sont conçus à neuf | à fournir |
| `c1/lacs_cotes_zones_humides.py` | Lacs, côtes et zones humides | Implémentation de référence de la séance C1, à insérer dans le pipeline du notebook | à fournir |
| `c1/saisons.py` | Températures mensuelles et recoloration saisonnière | Implémentation de référence de la séance C1 | à fournir |

Les sorties utiles à la lecture (cartes, graphiques) peuvent rester dans les notebooks. Les données lourdes ou recalculables n'ont pas leur place dans le dépôt.
