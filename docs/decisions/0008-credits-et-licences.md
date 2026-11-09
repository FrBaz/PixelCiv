# ADR 0008 — Crédits et avis de licence

Statut : accepté · 9 novembre 2026 · tâche 0.13

## Contexte

Le PRD veut que l'auteur de chaque asset tiers soit crédité dès l'intégration (AST-02), et des crédits affichés dans le jeu (IHM-08). Les bibliothèques distribuées avec le jeu sont sous licences MIT ou ISC (AST-05). Ces licences demandent de joindre leur texte et leur mention de copyright à toute copie du logiciel.

Or le jeu publié sur GitHub Pages est minifié, et le code produit ne contient plus aucune de ces mentions. L'option `build.license` de Vite produirait un avis, mais elle ignore les bundles des workers, où passe toute la simulation.

## Décision

- **`CREDITS.md`**, à la racine, recense tout ce que le jeu doit à d'autres : pack de sprites, bibliothèques distribuées (auteurs, rôle, licence, lien), algorithmes repris et outils de développement. L'écran des crédits en reprendra le contenu.
- **Au build**, `tools/bundle-licenses.ts` relève les paquets de tous les bundles, celui du fil principal comme ceux des workers. Le build échoue si l'un d'eux est sous une licence non admise (ADR 0001), ou s'il n'est pas cité dans `CREDITS.md`, sous son nom entre accents graves.
- **Le build joint au jeu `licenses.txt`** : la liste de ces paquets, avec leur version, leur licence et leur texte de licence. C'est un fichier texte, que le navigateur affiche tel quel.
- **Feuilles de style.** Une feuille de style insère ce qu'elle importe sans en faire des modules. Le build suit donc lui-même ses `@import`, ses `url()` et ses `image-set()`, de proche en proche, styles de `index.html` compris. Il résout les chemins comme Vite, relatifs d'abord, même sans « ./ » ; les paquets qu'il atteint sont contrôlés comme les autres.
- **Le pack de sprites** est crédité dans `CREDITS.md` dès son intégration, où que soient ses fichiers : dans `assets/source/` si sa licence permet de les redistribuer, sinon dans `assets/local/`, que git ignore (`assets/source/README.md`).

## Conséquences

- Ajouter une bibliothèque distribuée, même par dépendance indirecte, demande d'en créditer les auteurs : sinon le build échoue, et avec lui l'intégration continue.
- Une bibliothèque qui ne fournit pas son texte de licence apparaît dans `licenses.txt` avec sa seule licence déclarée. C'est le cas de `@pixi/colord`.
- Les assets tiers autres que du code (sprites, polices, sons) ne passent pas par le bundle : leur crédit reste à la charge de qui les intègre.
- Un paquet de CSS désigné par son seul nom (`@import 'normalize.css'`), que Vite résout par son champ `style`, est contrôlé ; les feuilles qu'il importe à son tour ne sont pas suivies, et son crédit doit citer les paquets qu'elles incluent.
