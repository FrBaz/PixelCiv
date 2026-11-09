# ADR 0007 — Sauvegardes

Statut : accepté · 9 novembre 2026 · tâche 0.11

## Contexte

Les sauvegardes sont locales, automatiques et manuelles. On les exporte et les importe en fichiers pour passer d'un appareil à l'autre, et leur format est versionné, avec migration des anciennes sauvegardes (NF-05). Le plan (section 3) prévoit les tableaux typés en binaire, le reste en JSON, le tout compressé, dans IndexedDB. Une partie rechargée doit se dérouler à l'identique (NF-09).

## Décision

- **Format.** Un conteneur binaire, compressé en gzip (`CompressionStream`, disponible dans le worker comme sous Node) :

  `PXCV` · version (u16) · longueur de l'en-tête (u32) · en-tête JSON · tableaux typés, chacun aligné sur 8 octets.

  L'en-tête porte les métadonnées (graine, pas), les données JSON et la place de chaque tableau ; Zod le valide à la lecture. Les tableaux se suivent, alignés, sans recouvrement ni nom répété. Les nombres sont petit-boutistes.
- **Taille.** Un fichier ne dépasse pas `MAX_SAVE_BYTES` (64 Mo), compressé ou non, ni son en-tête JSON `MAX_HEADER_BYTES` (8 Mo), dont l'analyse coûte bien plus de mémoire que ses octets. La décompression s'arrête dès que la limite est franchie, ou dès que le début du fichier n'est pas celui d'une sauvegarde. Un fichier forgé ne peut donc faire allouer au worker que quelques centaines de mégaoctets au pire.
- **Versions.** Une sauvegarde plus ancienne passe par les migrations successives, de la version v à v + 1. Elles appartiennent à `src/sim/save.ts`, qui connaît le contenu, et le worker les fournit à la lecture. Une sauvegarde plus récente est refusée. Chaque refus a sa raison : pas une sauvegarde, version trop récente, version trop ancienne pour être migrée, fichier abîmé, fichier trop gros. Version 2 : les commandes en attente entrent dans la sauvegarde.
- **Contenu.** `src/sim/save.ts` copie l'état d'un coup : couches et positions en tableaux typés ; journal des commandes, commandes en attente du prochain pas, états des flux du générateur et taille du monde en JSON. À la relecture, chaque champ est vérifié, seul et avec les autres : type et longueur des tableaux, taille de monde prédéfinie, promeneurs dans le monde, journal ordonné et antérieur au pas courant, flux présents et non nuls. La vitesse et la pause ne font pas partie de l'état.
- **Répartition.** Le worker produit et relit les fichiers, une opération après l'autre : une sauvegarde demandée pendant un chargement porte sur la partie chargée. Le fil principal les range dans IndexedDB, un enregistrement par emplacement (manuel, automatique), et les échange avec l'utilisateur. Une écriture ne compte qu'une fois sa transaction validée, et chaque action du joueur, réussie ou non, se conclut par un avis. La sauvegarde automatique reste discrète : elle ne signale que le premier échec du stockage, et note les autres dans la console. Le worker reçoit une copie de chaque fichier à relire, car le tampon envoyé est transféré : l'enregistrement reste ainsi intact.
- **Sauvegarde automatique.** Toutes les 30 s et quand la page passe en arrière-plan. Au démarrage, le jeu reprend la sauvegarde automatique s'il en trouve une. S'il ne peut pas la relire, il le dit, la met de côté (emplacement `auto-unreadable`) pour que la suivante ne l'écrase pas, et commence une nouvelle partie.
- **Fichiers.** L'export télécharge un fichier `.pxcv`, l'import en lit un. Sans IndexedDB (navigation privée, stockage refusé), le jeu tourne sans sauvegarde locale, le dit au démarrage, et garde l'export et l'import.

## Conséquences

- Tout changement de l'état sauvegardé augmente la version du format et ajoute une migration.
- Une partie rechargée se poursuit à l'identique, ce que vérifie un test par empreinte.
- Les sauvegardes n'enregistrent pas encore les identifiants du contenu qu'elles emploient (ADR 0006) : il le faudra dès que l'état référencera des biomes ou d'autres données.
