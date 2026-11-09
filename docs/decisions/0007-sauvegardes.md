# ADR 0007 — Sauvegardes

Statut : accepté · 9 novembre 2026 · tâche 0.11

## Contexte

Les sauvegardes sont locales, automatiques et manuelles. On les exporte et les importe en fichiers pour passer d'un appareil à l'autre, et leur format est versionné, avec migration des anciennes sauvegardes (NF-05). Le plan (section 3) prévoit les tableaux typés en binaire, le reste en JSON, le tout compressé, dans IndexedDB. Une partie rechargée doit se dérouler à l'identique (NF-09).

## Décision

- **Format.** Un conteneur binaire, compressé en gzip (`CompressionStream`, disponible dans le worker comme sous Node) :

  `PXCV` · version (u16) · longueur de l'en-tête (u32) · en-tête JSON · tableaux typés, chacun aligné sur 8 octets.

  L'en-tête porte les métadonnées (graine, pas), les données JSON et la place de chaque tableau ; Zod le valide à la lecture. Les tableaux se suivent, alignés, sans recouvrement ni nom répété. Les nombres sont petit-boutistes.
- **Taille.** Un fichier ne dépasse pas `MAX_SAVE_BYTES` (64 Mo), compressé ou non, ni son en-tête JSON `MAX_HEADER_BYTES` (8 Mo), dont l'analyse coûte bien plus de mémoire que ses octets. La lecture les refuse, et l'écriture aussi : elle ne produit jamais un fichier qu'elle ne relirait pas. La décompression s'arrête dès que la limite est franchie, ou dès que le début du fichier n'est pas celui d'une sauvegarde. Aucune collection n'est validée d'un bloc : la liste des tableaux est bornée (`MAX_SAVED_ARRAYS`), les flux du générateur sont comptés (`MAX_STREAMS`), et commandes et flux se vérifient un à un, jusqu'à la première erreur. Sinon, Zod relèverait chaque champ invalide de millions d'éléments forgés. Mesuré sous Node : un fichier forgé de 8 Ko, dont l'en-tête de 8 Mo est rempli d'éléments vides, est refusé en une seconde environ, et le processus culmine à 400 Mo.
- **Versions.** Une sauvegarde plus ancienne passe par les migrations successives, de la version v à v + 1. Elles appartiennent à `src/sim/save.ts`, qui connaît le contenu, et le worker les fournit à la lecture. Une sauvegarde plus récente est refusée. Chaque refus a sa raison : pas une sauvegarde, version trop récente, version trop ancienne pour être migrée, fichier abîmé, fichier trop gros. Version 2 : les commandes en attente entrent dans la sauvegarde. Version 3 : le monde généré de la phase 1 remplace la grille de test ; les versions 1 et 2, parties de test sans monde, n'ont pas de migration et sont refusées comme trop anciennes.
- **Contenu.** `src/sim/save.ts` copie l'état d'un coup : les dix couches du monde en tableaux typés ; paramètres du monde, version du générateur, journal des commandes, commandes en attente du prochain pas et états des flux du générateur en JSON. La sauvegarde garde le monde lui-même, et non sa seule graine : elle reste lisible quand le générateur change. Elle nomme les biomes et les ressources dont ses couches donnent les indices : relue après un changement du contenu, elle ramène chaque indice à celui d'aujourd'hui, et se refuse comme trop ancienne si un identifiant a disparu. À la relecture, chaque champ est vérifié, seul et avec les autres : paramètres dans leurs bornes et graine identique à celle de l'en-tête, type et longueur des couches, indices du contenu dans leurs listes, codes d'écoulement lisibles, journal ordonné et antérieur au pas courant, flux non nuls. La vitesse et la pause ne font pas partie de l'état.
- **Répartition.** Le worker produit et relit les fichiers, une opération après l'autre : une sauvegarde demandée pendant un chargement porte sur la partie chargée. Le fil principal les range dans IndexedDB, un enregistrement par emplacement (manuel, automatique), et les échange avec l'utilisateur. Une écriture ne compte qu'une fois sa transaction validée, et chaque action du joueur, réussie ou non, se conclut par un avis. La sauvegarde automatique reste discrète : elle ne signale que le premier échec du stockage, et note les autres dans la console. Le worker reçoit une copie de chaque fichier à relire, car le tampon envoyé est transféré : l'enregistrement reste ainsi intact.
- **Sauvegarde automatique.** Toutes les 30 s et quand la page passe en arrière-plan. Au démarrage, le jeu reprend la sauvegarde automatique s'il en trouve une. S'il ne peut pas la relire, il le dit, la met de côté (emplacement `auto-unreadable`) pour que la suivante ne l'écrase pas, et commence une nouvelle partie.
- **Fichiers.** L'export télécharge un fichier `.pxcv`, l'import en lit un. Sans IndexedDB (navigation privée, stockage refusé), le jeu tourne sans sauvegarde locale, le dit au démarrage, et garde l'export et l'import.

## Conséquences

- Tout changement de l'état sauvegardé augmente la version du format et ajoute une migration.
- Le journal des commandes grossit sans fin : vers 130 000 commandes, l'en-tête atteint 8 Mo, et la sauvegarde échoue (« La sauvegarde a échoué. »). Il faudra le compacter avant que les parties n'accumulent de vraies commandes.
- Une partie rechargée se poursuit à l'identique, ce que vérifie un test par empreinte.
- Mesuré sous Node, une sauvegarde compressée pèse 0,7 Mo pour un monde Petit, 2,5 Mo pour un monde Grand et 8,9 Mo pour un monde Immense, bien en deçà de `MAX_SAVE_BYTES` ; son écriture prend 0,3 s pour un monde Grand, 0,9 s pour un monde Immense.
