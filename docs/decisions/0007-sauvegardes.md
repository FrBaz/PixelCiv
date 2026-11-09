# ADR 0007 — Sauvegardes

Statut : accepté · 9 novembre 2026 · tâche 0.11

## Contexte

Les sauvegardes sont locales, automatiques et manuelles. On les exporte et les importe en fichiers pour passer d'un appareil à l'autre, et leur format est versionné, avec migration des anciennes sauvegardes (NF-05). Le plan (section 3) prévoit les tableaux typés en binaire, le reste en JSON, le tout compressé, dans IndexedDB. Une partie rechargée doit se dérouler à l'identique (NF-09).

## Décision

- **Format.** Un conteneur binaire, compressé en gzip (`CompressionStream`, disponible dans le worker comme sous Node) :

  `PXCV` · version (u16) · longueur de l'en-tête (u32) · en-tête JSON · tableaux typés, chacun aligné sur 8 octets.

  L'en-tête porte les métadonnées (graine, pas), les données JSON et la place de chaque tableau ; Zod le valide à la lecture. Les nombres sont petit-boutistes.
- **Versions.** Une sauvegarde plus ancienne passe par les migrations successives (`MIGRATIONS`, de la version v à v + 1) ; une sauvegarde plus récente est refusée. Chaque refus a sa raison : pas une sauvegarde, version trop récente, fichier abîmé.
- **Contenu.** `src/sim/save.ts` copie l'état d'un coup : couches et positions en tableaux typés ; journal des commandes, états des flux du générateur et taille du monde en JSON. À la relecture, chaque tableau est vérifié dans son type et sa longueur. La vitesse et la pause ne font pas partie de l'état.
- **Répartition.** Le worker produit et relit les fichiers ; le fil principal les range dans IndexedDB, un enregistrement par emplacement (manuel, automatique), et les échange avec l'utilisateur.
- **Sauvegarde automatique.** Toutes les 30 s et quand la page passe en arrière-plan. Au démarrage, le jeu reprend la sauvegarde automatique s'il en trouve une.
- **Fichiers.** L'export télécharge un fichier `.pxcv`, l'import en lit un. Sans IndexedDB (navigation privée, stockage refusé), le jeu tourne sans sauvegarde locale mais garde l'export et l'import.

## Conséquences

- Tout changement de l'état sauvegardé augmente la version du format et ajoute une migration.
- Une partie rechargée se poursuit à l'identique, ce que vérifie un test par empreinte.
- Les sauvegardes n'enregistrent pas encore les identifiants du contenu qu'elles emploient (ADR 0006) : il le faudra dès que l'état référencera des biomes ou d'autres données.
