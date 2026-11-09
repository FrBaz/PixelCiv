# Backlog

Les tickets du projet sont tenus ici tant que la CLI `gh` n'est pas disponible dans les sessions de Claude Code (PLAN, section 12). On pourra les reporter en tickets GitHub, rattachés au jalon de leur phase.

Chaque ticket donne lieu à une branche et à une PR (CLAUDE.md, section « Méthode »). Les phases suivantes seront détaillées ici à leur ouverture.

États possibles : à faire, en cours, à relire, fait.

## Phase 0 — Socle technique

Objectif : un projet outillé, testé et déployé automatiquement, avec l'architecture en place (fil principal, worker, protocole, temps, caméra, traduction, données, sauvegarde), avant tout contenu de jeu.

**Jalon 0.** Sur PC et sur téléphone, une grille de test qui boucle d'est en ouest, zoomable, avec contrôle du temps, panneau de débogage et sauvegarde.

| # | Tâche | Exigences | Critère d'acceptation | État |
|---|---|---|---|---|
| 0.1 | Projet Vite et TypeScript strict, arborescence, ESLint, Prettier, Vitest ; scripts `dev`, `build`, `test`, `typecheck`, `lint` ; licences des dépendances vérifiées. | NF-11, AST-05 | `npm test` et `npm run build` passent. | fait |
| 0.2 | Documentation : PRD et plan dans `docs/` ; premiers ADR (pile technique, monde cylindrique, déterminisme, communication avec le worker) ; relecture de `CLAUDE.md`. | — | ADR rédigés et cités dans le plan. | fait |
| 0.3 | Intégration continue GitHub Actions (lint, types, tests, build) et déploiement sur GitHub Pages à chaque fusion sur `main`. | — | Chaque PR affiche ses vérifications ; `main` est en ligne. | fait |
| 0.4 | Squelette d'application : page plein écran, canvas PixiJS, couche d'interface Preact, redimensionnement, orientation, zones de sécurité des téléphones. | IHM-06, IHM-07 | Affichage correct en paysage et en portrait. | fait |
| 0.5 | Worker de simulation et protocole de messages typé : commandes, instantanés, deltas, tampons transférés. Une seule simulation pour tous les modes. | NF-02, MOD-01 | Un pas factice de 200 ms ne fait pas chuter l'affichage. | fait |
| 0.6 | Boucle de temps : pas mensuel, calendrier, pause, plusieurs vitesses, horodatage des commandes. | MOD-06 | Une année dure environ 10 s en vitesse normale. | fait |
| 0.7 | PRNG à flux nommés et maths déterministes (`src/core/rng.ts`, `src/core/dmath.ts`). | NF-09 | Même graine, même suite, sous Node comme dans les navigateurs. | fait |
| 0.8 | Caméra : déplacement et zoom à la souris, au clavier et au doigt, sur une grille de test qui boucle d'est en ouest. | MON-01, IHM-07 | Défilement sans fin, sans saut à la couture. | fait |
| 0.9 | Traduction : clés, fichier français, pluriels et genre ; un test échoue si une clé manque. | NF-06, POL-04 | Aucun texte en dur dans le squelette. | fait |
| 0.10 | Données : chargement et validation par schémas ; premier fichier `data/biomes.json` (biomes du prototype) ; validation en intégration continue. | NF-07, MON-10 | Une donnée invalide fait échouer l'intégration continue. | fait |
| 0.11 | Sauvegarde minimale : IndexedDB, format versionné, export et import de fichier. | NF-05 | Une partie factice survit à un rechargement et passe d'un appareil à l'autre. | fait |
| 0.12 | Panneau de débogage : images par seconde, durée des pas, mémoire. | NF-01 | Visible sur PC et téléphone. | fait |
| 0.13 | Prototypes dans `prototypes/`, pack de sprites dans `assets/source/` si sa licence le permet, fichier `CREDITS.md`. | AST-01, AST-02 | Crédits renseignés. | fait |

### Notes

- **0.2.** ADR 0001 à 0004 rédigés dans `docs/decisions/` et cités dans le plan (section 3, version 0.4). `CLAUDE.md` relu : renvoi au backlog, commande `format`, dossier `src/worker/`, portée des règles ESLint, règle sur les dépendances. La convention d'import et le lanceur des outils restent à revoir avec le premier outil lancé directement par Node (ADR 0001).
- **0.3.** Fait : `.github/workflows/ci.yml` (lint, types, tests, build, audit, puis déploiement sur GitHub Pages à chaque fusion sur `main`), Node 26 dans `.nvmrc`, chemins relatifs (`base: './'`) et contrôle au build des licences du bundle (`tools/bundle-licenses.ts`). Pour que `main` soit en ligne, il faut activer GitHub Pages avec « GitHub Actions » comme source (PLAN, section 12, étape 2).

  `npm audit` signale une faille modérée de minimatch, corrigée en 11.0.1, alors qu'ESLint et typescript-eslint dépendent encore de minimatch 10. C'est un déni de service par motif glob malveillant, sans conséquence pour des outils qui ne lisent que nos propres motifs : l'intégration continue ne s'arrête qu'aux failles de niveau élevé ou critique, en attendant que les deux passent à minimatch 11.0.1 ou plus.
- **0.4.** Vérifié dans Chromium, en paysage et en portrait, sur PC et sur téléphone émulé : le canvas couvre l'écran à sa densité de pixels, l'interface respecte les zones de sécurité. Preact 10 plutôt que 11, trop récent (ADR 0001).
- **0.5.** Mesuré dans Chromium avec `?stepCost=200`, qui ajoute 200 ms de calcul à chaque pas : 60 images/s, avec ou sans ce coût, et jamais plus de 17 ms entre deux images. Cette mesure précède la carte de 0.8 ; elle a été refaite en 0.12. Le worker est hébergé par `src/worker/`, qui seul lit l'horloge (ADR 0004).
- **0.6.** Mesuré dans Chromium : 12 mois en 10,0 s en vitesse normale et 24 mois en 5 s en vitesse rapide (×4) ; la pause et le pas unique répondent. Les commandes de jeu sont horodatées du pas où elles s'appliquent et journalisées : rejouer le journal redonne la même empreinte. Les contrôles du temps tiennent jusqu'à 320 px de large.
- **0.7.** Les suites du générateur et son empreinte dans l'auto-test ont été recalculées par une implémentation indépendante, en Python ; celles de xoshiro128** pour l'état [1, 2, 3, 4] sont celles de ses auteurs. Face à Math, `dmath` reste à 1 ulp pour exp, à 3 ulp pour log, et à 2 ulp pour sin et cos jusqu'à 1,6 × 10^6, zéros compris. pow est exacte pour les puissances entières de deux et les petites puissances entières d'entiers ; ailleurs, elle reste à 4 × 10^-14 près en relatif pour un résultat entre 10^-30 et 10^30, et à 3 × 10^-13 près des débordements (ADR 0003). La relecture de la phase 0 a corrigé sin et cos près de leurs zéros et au-delà de 1,6 × 10^6, ainsi que pow pour les grands exposants entiers, les sous-normaux et les débordements. L'auto-test recalcule les empreintes dans le navigateur : le panneau de débogage (0.12) en affiche le résultat.
- **0.8.** Vérifié dans Chromium, jeu en pause : après un glissement d'exactement une largeur de monde, l'image revient identique au pixel près ; une ligne qui traverse la couture ne compte aucun pixel de fond. La molette, le pincement à deux doigts (téléphone émulé) et l'appui bref, qui peint la case touchée par une commande de jeu, fonctionnent. Des promeneurs de test, tirés du générateur, animent la grille au fil des mois.
- **0.9.** Traitée avant 0.5, puisque les tâches suivantes affichent du texte. Clés typées depuis `src/i18n/fr.json`, pluriels, genre ; le titre de la page passe par `t()`. Un test échoue si une clé manque ou ne sert plus, et ESLint refuse le texte en dur dans le JSX (ADR 0005).
- **0.10.** Sur ta demande, `data/biomes.json` reprend directement les 32 biomes de C1 (D6), et non ceux du prototype ; un test le confronte à la liste de C1. Les valeurs (fertilité, coûts, densités de flore, palettes) sont une première proposition, à calibrer en phase 1. Les ressources sont des identifiants que `data/resources.json` définira en 1.6 (ADR 0006).
- **0.11.** Vérifié dans Chromium : une case peinte survit au rechargement de la page, par la sauvegarde automatique ; un fichier exporté (922 octets) se réimporte dans un autre profil avec la même partie ; un fichier étranger est refusé avec un message clair. Une partie rechargée se poursuit à l'identique, ce que vérifie un test par empreinte (ADR 0007).
- **0.12.** Le panneau s'ouvre par son bouton, par F3 ou par la touche ², sous Échap. Il affiche les images par seconde et l'image la plus longue de la dernière seconde, la durée moyenne et maximale des 30 derniers pas, la mémoire du tas JavaScript (Chromium seulement), le moteur de rendu et la densité de pixels, la taille du monde, le contenu chargé et le résultat de l'auto-test du déterminisme. Vérifié dans Chromium, sur PC (1280 × 720) et sur téléphone émulé (Pixel 7) : le panneau tient dans l'écran, et la cadence est la même qu'il soit ouvert ou fermé.

  Sans carte graphique, Chromium dessine en logiciel, vers 25 millions de pixels par seconde. La carte plein écran y tourne donc à 25 images/s en 1280 × 720, mais à 60 images/s en 640 × 360. À cette taille, `?stepCost=200` porte bien la durée des pas à 200 ms, sans faire chuter l'affichage (60 images/s, 17 ms au plus entre deux images) : le critère de 0.5 tient toujours.
- **0.13.** `CREDITS.md` crédite les bibliothèques distribuées avec le jeu (auteurs, rôle, licence, lien), les algorithmes repris et les outils de développement ; la place du pack de sprites y est prête. Le build échoue si une bibliothèque distribuée, du fil principal comme du worker, manque aux crédits. Il joint aussi au jeu `licenses.txt`, qui reprend leurs textes de licence, absents du code minifié (ADR 0008). `prototypes/README.md` liste les notebooks et scripts attendus. `assets/source/README.md` décrit la marche à suivre pour le pack, et git ignore `assets/local/`, où irait un pack non redistribuable.

  Restent à verser les fichiers eux-mêmes, que seul l'auteur peut fournir : notebooks, scripts de C1, pack de sprites avec sa licence, nom de son auteur et lien (PRD, question 14). Le tableau ci-dessous les recense.

### Relecture de la phase 0

La phase terminée, des relecteurs indépendants l'ont relue en quatre domaines : cœur et worker, sauvegardes et données, interface et rendu, outillage et documentation. Chaque remarque a été reproduite par du code, puis corrigée avec un test qui l'aurait détectée, ou vérifiée dans Chromium quand elle touchait au navigateur.

- **Première relecture : 40 défauts**, corrigés dans les commits « relecture : … ». Les plus sérieux : des commandes perdues par la sauvegarde, des chargements concurrents qui s'écrasaient, des écritures d'IndexedDB comptées avant d'être validées, une décompression sans limite, des fichiers forgés acceptés (taille de monde, disposition des tableaux), des règles ESLint contournables (alias de `Math`, globs, texte dans une condition), la densité de pixels de l'écran figée au démarrage.
- **Deuxième relecture, des corrections elles-mêmes : 23 défauts**, corrigés dans « relecture 2 : … ». Chaque remarque y a été soumise à un vérificateur chargé de la réfuter. Entre autres : une sauvegarde automatique illisible qui n'était pas mise de côté, faute de copie du tampon transféré au worker ; le zoom du navigateur qui étirait la carte ; un pincement au pavé tactile qui zoomait la page ; `?stepCost` refusé par la poignée de main ; des fichiers du projet pris pour des paquets par le contrôle des feuilles de style.
- **Troisième relecture, des corrections de la deuxième : 7 défauts**, corrigés dans « relecture 3 : … ». Le zoom du navigateur laissait `app.screen` à l'ancienne taille, et un fichier forgé de 8 Ko faisait encore allouer 1,7 Go, Zod relevant chaque champ invalide de millions de commandes.

- **Quatrième relecture, des corrections de la troisième : 3 défauts**, corrigés dans « relecture 4 : … ». Le principal : la liste des tableaux de l'en-tête et les flux du générateur étaient encore validés d'un bloc par Zod, et un fichier forgé de 8 Ko coûtait encore des gigaoctets. Toutes les collections d'une sauvegarde sont désormais bornées ou vérifiées une à une.

Le nombre de défauts décroît d'une relecture à l'autre (40, 23, 7, puis 3), sans garantie d'être nul.

Restent ouverts, et notés dans les ADR :
- le journal des commandes grossit sans fin, et la sauvegarde échoue vers 130 000 commandes : il faudra le compacter (ADR 0007) ;
- la règle des textes ne suit ni les variables ni les tableaux (ADR 0005) ;
- un paquet de CSS désigné par son seul nom est contrôlé, mais pas les feuilles qu'il importe à son tour (ADR 0008) ;
- dans `pow`, un résultat voisin du plus grand double peut passer du mauvais côté de la limite (ADR 0003).

## Phase 1 — Génération du monde

Objectif : porter le pipeline du prototype en TypeScript, sur un monde cylindrique, avec un rendu fidèle et fluide, en y intégrant les corrections de la séance C1 (relief, climat, eaux, côtes, saisons). Les décisions D1 à D13 de `docs/design/C1-monde.md` font foi ; `prototypes/c1/` en donne une implémentation de référence.

**Jalon 1.** On génère un monde cylindrique à partir d'une graine, avec ses montagnes, ses lacs, ses côtes et ses climats. On l'explore sur PC et sur téléphone pendant que les saisons passent.

| # | Tâche | Exigences | Critère d'acceptation | État |
|---|---|---|---|---|
| 1.1 | Bruit simplex 3D déterministe et échantillonnage sur un cylindre : la longitude devient un angle, et la carte se referme d'est en ouest. | MON-01, MON-04 | Valeurs continues à la couture ; même graine, même bruit. | fait |
| 1.2 | Relief : bruit fractal à trois échelles, plus des chaînes de montagnes par bruit de crêtes (D12). Paramètres : niveau de la mer, part des terres, relief. Correspondance en mètres et 20 niveaux d'altitude (D11). | MON-03, MON-05, MON-14 | 3 à 6 % des terres au-dessus de la moyenne montagne ; crêtes continues, avec des cols. | fait |
| 1.3 | Climat : températures recalibrées, gradient de 6,5 °C par 1 000 m ; précipitations par bandes de latitude, vents dominants et ombre pluviométrique ; continentalité ; températures mensuelles (D8, D13). | MON-04, MON-15, SAI-01, SAI-02 | Environ 27 °C à l'équateur et −25 °C aux pôles ; présence de déserts subtropicaux et de déserts d'abri. | fait |
| 1.4 | Hydrologie continue d'est en ouest. Un seul niveau de la mer, et un océan limité aux eaux reliées à l'océan mondial (D1). Remplissage avec pente minimale sur les plats, puis accumulation. Lacs par bilan hydrique (D2) et trois classes de rivières (D3). L'alias du prototype est corrigé. | MON-04, MON-07, MON-11 | Toute rivière rejoint la mer ou un lac ; aucune n'est coupée à la couture, ni rectiligne. | fait |
| 1.5 | Les 32 biomes naturels (D6), décrits dans `data/biomes.json` et classés selon le mois le plus chaud et le plus froid (D13). Côtes typées (D4) et zones humides (D5). | MON-08, MON-10, MON-12, MON-13 | Plages sur une seule rangée côtière ; glaciers seulement là où le mois le plus chaud reste sous 0 °C. | fait |
| 1.6 | Ressources et flore : gisements selon l'altitude et le biome, ressources des milieux humides et salés, densités d'arbres et de buissons. | RES-01, RES-03, RES-05 | Répartition lisible en mode de carte « ressources ». | fait |
| 1.7 | Cuisson des blocs dans un worker : tuiles de 4 px avec variations, débordement du relief, shader (pente, lumière du nord-est, teinte thermique). Texture de données des saisons, une valeur par case (D10). | REN-01, REN-02, REN-09, REN-10 | Rendu fidèle au prototype, sans couture visible. | fait |
| 1.8 | Affichage : zoom net, niveaux de détail de base, modes de carte « relief », « biomes » et « ressources » avec légende. Neige et glace saisonnières, par shader et palettes saisonnières (D10). | REN-03, REN-08, REN-10, IHM-01 | 60 images/s sur PC et 30 sur téléphone, sur une carte Grand, saisons comprises. | fait |
| 1.9 | Écran de création : graine, taille, paramètres, aperçu, régénération. | CRE-01, MON-02 | Utilisable au doigt sur téléphone. | fait |
| 1.10 | Tests et bancs d'essai : empreinte des cartes par graine, continuité de la couture, durée de génération par taille. | NF-03, NF-09 | Un monde Grand se génère en moins de 10 s sur PC ; la mesure sur téléphone est consignée. | fait |

### Notes

Les dix tâches sont faites, chacune dans son commit (« 1.1 : … » à « 1.10 : … »), plus un commit qui branche le monde généré dans la simulation (protocole 2, sauvegardes 3). Décisions : ADR 0009 (génération) et ADR 0010 (rendu).

**Mesures sur cinq mondes Grand**, aux paramètres par défaut (graines `pixelciv`, `alpha`, `beta`, `gamma`, `delta`) :

| Mesure | Cible | Résultat |
|---|---|---|
| Part des terres | 35 % (paramètre) | 35,6 à 35,9 % |
| Terres au-dessus de 1 800 m (moyenne montagne et plus) | 3 à 6 % (MON-14) | 4,4 à 4,5 % |
| Lacs (doux, salés, salars) | — | 2,5 à 5,3 % des terres |
| Glaciers | là où le mois le plus chaud reste sous 0 °C | 11,6 à 17,4 % des terres, surtout aux pôles |
| Déserts | subtropicaux et d'abri | 2,8 à 9,6 % des terres |
| Zones humides | — | 4,9 à 7,8 % des terres |
| Plages | une seule rangée côtière (D4) | 1,8 à 2,7 % des terres |
| Température annuelle, toutes cases de la bande | ≈ 27 °C à l'équateur, ≈ −25 °C aux pôles | 25,0 à 26,8 °C ; −23,6 à −24,5 °C (montagnes comprises) |
| Rivières | — | 4 000 à 5 000 cases de ruisseau, 1 900 à 2 300 de rivière, 500 à 800 de fleuve |

**Durées de génération** (`npm run bench`, Node 22, conteneur de développement) : Petit 0,70 s, Moyen 1,32 s, Grand 2,22 s, Immense 8,89 s. Dans Chromium, dans le worker : Moyen 1,7 s, Grand 2,7 s ; la carte Grand est entièrement cuite environ 3 s plus tard. NF-03 (Grand en moins de 10 s sur PC) est tenu.

**Téléphone, en émulation seulement.** Chromium ne ralentit pas les workers (« Operation is only supported for pages, not workers ») : la génération a été mesurée sur le fil principal d'une page au processeur ralenti 4 fois, le ralentissement que Lighthouse prête à un téléphone de milieu de gamme. Petit 3,1 s, Moyen 6,5 s, Grand 10,6 s. D'où le Moyen par défaut au doigt (MON-02 laisse ce défaut à calibrer), et l'Immense réservé au PC. **À confirmer sur un vrai téléphone** : après la création d'un monde, le panneau de débogage donne la durée de la génération.

**Images par seconde : non mesurées.** Le Chromium sans écran du conteneur dessine en logiciel (SwiftShader) : 31 images/s en 1280 × 720 sur une carte Grand, 13 à 15 en émulation de téléphone, ce qui ne dit rien d'une vraie carte graphique. Le critère de 1.8 (60 images/s sur PC, 30 sur téléphone) reste à vérifier sur des appareils réels, avec le panneau de débogage. Le rendu est conçu pour : un maillage par bloc visible, sans recuisson pour les saisons, et des mipmaps sous le zoom 1.

**Écarts à C1 et calibrations** (détails dans l'ADR 0009) :
- D1 : seuil de l'océan à 0,5 % de la carte, au lieu de « par exemple 2 % », qui changeait trop de mers intérieures en lacs.
- D2 : les sédiments comblent 85 % de chaque cuvette avant les lacs ; sans cela, les lacs couvraient 8 à 13 % des terres.
- D3 : seuils des rivières en débit par case d'une carte Grand (ruisseau, ×4 rivière, ×16 fleuve), divisés par le paramètre « rivières ».
- Le biome « rivière » est le lit d'un fleuve, infranchissable ; ruisseaux et rivières coulent sur les autres biomes.
- L'« alias du prototype », faute du notebook, est lu de trois façons, toutes couvertes (ADR 0009).
- Le fond s'abaisse un peu vers les pôles (mers polaires) ; une élévation polaire faisait des lacs de barrage.

**Contrôles de la tâche 1.10.** Empreintes de référence de quatre mondes, couche par couche (`src/worldgen/reference.test.ts`) : changer la génération les change, et oblige à augmenter `GENERATOR_VERSION`. Couture : toutes les couches, les biomes et les rivières passent la couture comme une paire de colonnes quelconque. Auto-test dans le navigateur : le worker génère un monde de 64 × 32 cases à la poignée de main et compare son empreinte ; le panneau de débogage dit « conforme aux références » dans Chromium.

**Interface.** L'inspection d'une case se fait d'un clic, d'un appui bref ou d'un appui long (IHM-07). Sans sauvegarde automatique, le jeu s'ouvre sur l'écran de création ; on peut y charger la sauvegarde manuelle ou importer un fichier. L'adresse peut encore nommer un monde pour le débogage (`?seed=abc&size=large`), qui commence alors directement.

## À fournir par l'auteur

| Quoi | Pour | Référence | État |
|---|---|---|---|
| Notebook `testMap_filtre.ipynb` | simple illustration pour la phase 1, qui s'appuie sur C1 et ses images | PLAN, section 12, étape 1 | non reçu |
| Notebooks `testArmoiries.ipynb` et `testVisages.ipynb`, simples illustrations : portraits et armoiries sont conçus à neuf | phases 2 et 4 | PLAN, version 0.3 | non reçus |
| Scripts de la séance C1, dans `prototypes/c1/` | phase 1, dont ils sont l'implémentation de référence | PLAN, sections 6 et 12 (étape 4) | versés |
| Images de la séance C1, dans `docs/design/C1/` : `avant-apres-tropiques.png`, `avant-apres-nord.png`, `saisons-nord.png` | phase 1 | PLAN, section 12, étape 4 | versées, converties depuis les pièces jointes (256 couleurs) |
| Animation `docs/design/C1/saisons.gif`, à laquelle renvoie `C1-monde.md` | phase 1 | PLAN, section 12, étape 4 | seule sa première image est arrivée, versée sous `saisons-janvier.png` |
| Pack de sprites : « 2D Pixel Art Male and Female Character », de GandalfHardcore, version gratuite | phase 2 et suivantes | AST-01, AST-02 ; PRD, question 14 | auteur et lien reçus ; licence à vérifier, `itch.io` étant hors de portée de la session ; non versé |
| Activation de GitHub Pages, avec « GitHub Actions » comme source | 0.3 | PLAN, section 12, étape 2 | faite : le déploiement de `main` a réussi |
