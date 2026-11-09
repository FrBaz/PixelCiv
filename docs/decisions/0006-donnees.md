# ADR 0006 — Contenu en données

Statut : accepté · 9 novembre 2026 · tâche 0.10

## Contexte

Le contenu du jeu (espèces, biomes, savoirs, biens, cultures, événements, titres…) est décrit par des données modifiables sans toucher au code (NF-07). Chaque biome porte sa fertilité, ses ressources, sa flore, son coût de déplacement et sa palette (MON-10). Le plan (section 3) prévoit du JSON, des schémas Zod, une validation au démarrage et dans l'intégration continue, et la conversion des identifiants textuels en indices.

## Décision

- **Fichiers.** Le contenu vit dans `data/`, un fichier JSON par sorte de contenu ; Vite l'intègre au bundle, ce qui le rend disponible hors ligne.
- **Schémas.** `src/core/data/schemas.ts` décrit chaque fichier avec Zod, en mode strict : un champ inconnu est une erreur. Les règles qui lient plusieurs champs s'y ajoutent, par exemple « seules les côtes ont une facilité de débarquement ». Les schémas vivent dans `src/core`, utilisable par le worker comme par le fil principal.
- **Textes.** Une donnée ne contient aucun texte affiché, seulement des clés de traduction (ADR 0005) ; les tests vérifient qu'elles existent.
- **Chargement.** `loadCatalog` valide un fichier, puis associe à chaque identifiant textuel son indice, sa position dans le fichier, que la simulation stockera dans ses tableaux typés. Une donnée invalide lève une `DataError`, qui liste chaque problème avec son chemin.
- **Contrôles.** Le jeu valide son contenu au démarrage. Les tests valident les vrais fichiers, donc l'intégration continue échoue sur une donnée invalide.
- **Biomes.** `data/biomes.json` reprend les 32 biomes naturels de la séance C1 (D6), dans ses huit familles. Un test le confronte à la liste de C1. Les ressources sont désignées par des identifiants, que `data/resources.json` définira avec la tâche 1.6.

## Conséquences

- Les indices dépendent de l'ordre des fichiers : une sauvegarde enregistre les identifiants textuels du contenu qu'elle emploie, pour se relire après un changement de contenu.
- Les valeurs des biomes (fertilité, coûts, palettes) sont une première proposition, que la phase 1 calibrera.
