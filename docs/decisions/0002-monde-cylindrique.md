# ADR 0002 — Monde cylindrique

Statut : accepté · 9 novembre 2026 · tâche 0.2

## Contexte

Le monde est un cylindre, continu d'est en ouest et bordé de pôles au nord et au sud (MON-01). Ni le relief, ni les rivières, ni les déplacements, ni les distances, ni l'affichage ne doivent laisser voir de couture. Les tailles de monde sont au format 2:1, de 512 × 256 à 2 048 × 1 024 cases (MON-02).

## Décision

- **Coordonnées.** Une case a des coordonnées entières `x` dans [0, largeur) et `y` dans [0, hauteur), `y = 0` étant le bord nord. Seul `x` boucle : les bords nord et sud sont de vrais bords.
- **Normalisation.** Toute coordonnée x est ramenée modulo la largeur par `wrapX` (`src/core/cylinder.ts`), y compris quand elle est négative.
- **Distances.** Toute distance horizontale suit le plus court chemin, à travers la couture si besoin : `deltaX` donne l'écart signé, et les distances entre cases en découlent.
- **Voisinage.** Les voisins d'une case sont pris modulo la largeur, dans tous les algorithmes (hydrologie, diffusion, déplacements).
- **Bruit.** Le bruit est échantillonné sur un cylindre : la longitude devient un angle θ, et l'on lit un bruit 3D au point (r·cos θ, r·sin θ, y), calculé avec `dmath` (ADR 0003, tâche 1.1).
- **Blocs.** La grille est découpée en blocs de 64 × 64 cases ; les tailles de monde sont des multiples de 64 dans les deux sens.
- **Affichage.** La caméra garde une position horizontale libre, ramenée modulo la largeur du monde. La colonne de blocs visible `i` affiche le bloc `i` modulo le nombre de colonnes : le monde se répète quand on dézoome.

## Conséquences

- Les algorithmes n'ont aucun cas particulier à la couture, pourvu qu'ils passent par ces fonctions.
- Les tests de chaque système vérifient la continuité à la couture, comme le demandent les tâches 1.1 et 1.4.
