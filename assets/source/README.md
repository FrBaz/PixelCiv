# Pack de sprites original

Ce dossier accueille le pack de sprites original (AST-01), si sa licence permet de le redistribuer. Le dépôt étant public, tout fichier versé ici est publié.

Le pack retenu, « 2D Pixel Art Male and Female Character » de GandalfHardcore, n'est pas ici : l'auteur du jeu en a versé les planches sans vêtements dans `sprites/humans/skin/`, avec sa licence vérifiée le 15 novembre 2026, et la tâche 2b.5 les a intégrées (`CREDITS.md`, ADR 0016). La marche à suivre reste celle-ci pour tout autre pack :

1. **Vérifier la licence.** Elle doit permettre un usage commercial, avec attribution (AST-02), et la redistribution des fichiers eux-mêmes, pour qu'ils puissent figurer dans un dépôt public.
2. **Ranger les fichiers.**
   - Si la licence le permet, les originaux vont ici, accompagnés du texte de la licence : des PNG transparents, avec vêtements, et non des copies dégradées.
   - Sinon, ils vont dans `assets/local/`, que git ignore. Le jeu publié ne pourra alors s'en servir que si la licence permet au moins de distribuer le jeu qui les contient.
3. **Créditer.** Le nom de l'auteur, le lien vers le pack et la licence vont dans `CREDITS.md` dès l'intégration, quel que soit l'emplacement des fichiers. L'écran des crédits du jeu en reprendra le contenu (IHM-08).

Les sources pixel art propres au jeu, éditables, vont dans `assets/pixel/` (AST-04).
