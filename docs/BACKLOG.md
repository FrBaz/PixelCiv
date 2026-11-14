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
| 1.8 | Affichage : zoom net, niveaux de détail de base, modes de carte « relief », « biomes » et « ressources » avec légende. Neige et glace saisonnières, par shader et palettes saisonnières (D10). | REN-03, REN-08, REN-10, IHM-01 | 60 images/s sur PC et 30 sur téléphone, sur une carte Grand, saisons comprises. | à relire : images/s à mesurer sur appareils |
| 1.9 | Écran de création : graine, taille, paramètres, aperçu, régénération. | CRE-01, MON-02 | Utilisable au doigt sur téléphone. | fait |
| 1.10 | Tests et bancs d'essai : empreinte des cartes par graine, continuité de la couture, durée de génération par taille. | NF-03, NF-09 | Un monde Grand se génère en moins de 10 s sur PC ; la mesure sur téléphone est consignée. | à relire : mesure sur un vrai téléphone |

### Notes

Les dix tâches sont réalisées, chacune dans son commit (« 1.1 : … » à « 1.10 : … »), plus un commit qui branche le monde généré dans la simulation (protocole 2, sauvegardes 3). Décisions : ADR 0009 (génération) et ADR 0010 (rendu). Deux critères demandent des appareils réels, hors de portée du conteneur : les images par seconde de 1.8, et la durée de génération sur téléphone de 1.10 ; ces deux tâches restent « à relire » jusqu'à ces mesures.

**Relecture de la phase 1.** Une relecture contradictoire a relevé 64 remarques ; 53 ont été confirmées par une seconde vérification, et toutes sont corrigées dans les commits « relecture : … » et « rendu : … ». La génération en sort changée : générateur version 2 (ADR 0009, révisé). Principaux changements : cols portés par les chaînes, correspondance de D11 dans les données, pluie de relief bornée, saisons communes (`src/core/seasons.ts`, saison sèche des tropiques comprise), lacs salés en vraie nappe, bassins fermés sans ligne droite, évaporation selon l'humidité et le dégel, zones humides de même part à toutes les tailles, ressources des milieux humides et salés visibles (RES-05).

**Mesures sur cinq mondes Grand**, générateur version 2, aux paramètres par défaut (graines `pixelciv`, `alpha`, `beta`, `gamma`, `delta`) :

| Mesure | Cible | Résultat |
|---|---|---|
| Part des terres | 35 % (paramètre) | 35,4 à 35,9 % |
| Terres au-dessus de 1 800 m (moyenne montagne et plus) | 3 à 6 % (MON-14) | 4,4 à 4,5 % |
| Lacs (doux, salés, salars) | — | 0,9 à 4,2 % des terres |
| Glaciers | là où le mois le plus chaud reste sous 0 °C | 11,1 à 17,7 % des terres, surtout aux pôles |
| Déserts | subtropicaux et d'abri | 2,1 à 5,1 % des terres |
| Zones humides | — | 5,2 à 8,3 % des terres, dont 4,2 à 7,2 % à l'intérieur des terres (marais, tourbières, marécages) |
| Plages | une seule rangée côtière (D4) | 2,1 à 3,4 % des terres |
| Température annuelle, toutes cases de la bande | ≈ 27 °C à l'équateur, ≈ −25 °C aux pôles | 25,0 à 26,8 °C ; −23,6 à −24,4 °C (montagnes comprises) |
| Rivières | — | 4 100 à 4 500 cases de ruisseau, 2 000 à 2 400 de rivière, 480 à 790 de fleuve |
| Pluie annuelle la plus forte | — | 13,6 à 14,9 m, contre 53 à 62 m avant la borne de la pluie de relief |

**Durées de génération** (`npm run bench`, Node 22, conteneur de développement, générateur version 2) : Petit 0,72 s, Moyen 1,48 s, Grand 2,37 s (2,47 s au plus), Immense 9,47 s. Dans Chromium, dans le worker : Moyen 1,7 s, Grand 2,7 s ; la carte Grand est entièrement cuite environ 3 s plus tard. NF-03 (Grand en moins de 10 s sur PC) est tenu.

**Téléphone, en émulation seulement.** Chromium ne ralentit pas les workers (« Operation is only supported for pages, not workers ») : la génération a été mesurée sur le fil principal d'une page au processeur ralenti 4 fois, le ralentissement que Lighthouse prête à un téléphone de milieu de gamme. Petit 3,1 s, Moyen 6,5 s, Grand 10,6 s. D'où le Moyen par défaut au doigt (MON-02 laisse ce défaut à calibrer), et l'Immense réservé au PC. **À confirmer sur un vrai téléphone** : après la création d'un monde, le panneau de débogage donne la durée de la génération.

**Images par seconde : non mesurées.** Le Chromium sans écran du conteneur dessine en logiciel (SwiftShader) : 31 images/s en 1280 × 720 sur une carte Grand, 13 à 15 en émulation de téléphone, ce qui ne dit rien d'une vraie carte graphique. Le critère de 1.8 (60 images/s sur PC, 30 sur téléphone) reste à vérifier sur des appareils réels, avec le panneau de débogage. Le rendu est conçu pour : un maillage par bloc visible, sans recuisson pour les saisons, et des mipmaps sous le zoom 1.

**Écarts à C1 et calibrations** (détails dans l'ADR 0009) :
- D1 : seuil de l'océan à 0,5 % de la carte, au lieu de « par exemple 2 % », qui changeait trop de mers intérieures en lacs.
- D2 : les sédiments comblent 85 % de chaque cuvette avant les lacs ; sans cela, les lacs couvraient 8 à 13 % des terres.
- D3 : seuils des rivières en débit par case d'une carte Grand (ruisseau, ×4 rivière, ×16 fleuve), divisés par le paramètre « rivières ».
- Le biome « rivière » est le lit d'un fleuve, infranchissable ; ruisseaux et rivières coulent sur les autres biomes.
- L'« alias du prototype », faute du notebook, est lu de trois façons, toutes couvertes (ADR 0009).
- Le fond s'abaisse un peu vers les pôles (mers polaires) ; une élévation polaire faisait des lacs de barrage.

**Contrôles de la tâche 1.10.** Empreintes de référence de cinq mondes, couche par couche (`src/worldgen/reference.test.ts`), dont un Moyen, où les étapes qui dépendent de la taille prennent les valeurs d'une carte Grand : changer la génération les change. On augmente alors `GENERATOR_VERSION`, que le test compare à la version des empreintes ; rien n'y oblige vraiment, sinon cette comparaison. Couture : les dix couches (catégories comprises : gisements et directions d'écoulement), les biomes et les rivières passent la couture comme une paire de colonnes quelconque. Le banc d'essai échoue si le plus lent des mondes Grand dépasse 10 s. Auto-test dans le navigateur : le worker génère un monde de 64 × 32 cases à la poignée de main et compare son empreinte ; le panneau de débogage dit « conforme aux références » dans Chromium.

**Interface.** L'inspection d'une case se fait d'un clic, d'un appui bref ou d'un appui long (IHM-07). Sans sauvegarde automatique, le jeu s'ouvre sur l'écran de création ; on peut y charger la sauvegarde manuelle ou importer un fichier. L'adresse peut encore nommer un monde pour le débogage (`?seed=abc&size=large`), qui commence alors directement.

## Phase 2 — Individus et démographie

Objectif : une population qui vit, se reproduit, transmet ses gènes et meurt, et qu'on peut observer (PLAN, section 7). Les groupes nomades suivent la séance C2 (D4, D13), et les saisons C1 (D9). Aucune exigence de la phase n'est marquée « à concevoir » dans le PRD. Décisions : ADR 0011.

**Jalon 2.** On fait apparaître un groupe d'humains. Il nomadise au fil des saisons, survit ou non, et ses enfants ressemblent à leurs parents. On suit les lignées.

| # | Tâche | Exigences | Critère d'acceptation | État |
|---|---|---|---|---|
| 2.1 | Population : une colonne en tableau typé par attribut, emplacements recyclés, identifiants stables, archive des morts ; sauvegarde 4 et empreinte de l'état. | IND-01, IND-03 | 50 000 vivants sans objet par individu ; les morts restent consultables ; une partie rechargée se poursuit à l'identique. | fait |
| 2.2 | Espèces et génétique : humains en trois sous-espèces décrits par des données (`data/species.json`) ; génome compact, allèles dominants et récessifs, traits continus par moyenne des parents et variation, mutations rares ; métissage. | IND-05, IND-06, ESP-01 à ESP-04 | Proportions mendéliennes retrouvées sur de grands croisements ; les enfants ressemblent à leurs parents ; ajouter une sous-espèce ne touche pas au code. | fait |
| 2.3 | Cycle de vie : âges, mortalité et fertilité par espèce, couples sans inceste, grossesses et naissances, causes de mort, surmortalité hivernale des plus fragiles. | IND-04, ESP-03, SAI-03 | Espérance de vie et fécondité plausibles pour des chasseurs-cueilleurs ; une population nourrie se maintient sur des siècles. | fait |
| 2.4 | Survie : cueillette, chasse et pêche par biome, rendements saisonniers, gibier et ressources qui s'épuisent et se régénèrent, faim et famine. | ECO-11, RES-03, RES-04, FAU-01, SAI-03 | Un groupe vit mieux en forêt tempérée qu'en toundra ; l'hiver et la surexploitation se font sentir. | fait |
| 2.5 | Groupes nomades : langue et culture embryonnaires dès l'apparition ; déplacements saisonniers vers les meilleurs terrains de leur aire, à environ 30 cases de plaine par mois ; scission au-delà d'une trentaine de membres. | CIV-05, MON-16 | Un groupe se déplace, se scinde en deux groupes de même culture, et ne traverse ni la mer ni les lacs. | fait |
| 2.6 | Noms : phonologie générée par langue (sons, syllabes, enchaînements), prénoms et noms de famille, règle de nommage de la culture. | LAN-01, IND-08 | Les noms d'une même langue se ressemblent, ceux de deux langues diffèrent ; une graine redonne les mêmes noms. | fait |
| 2.7 | Pipeline d'assets : sources éditables en grilles de texte, par rôle de teinte ; atlas générés à la compilation ; recoloration à l'exécution. | AST-03, AST-04, REN-09 | Une source modifiée change l'atlas au build suivant ; un même motif sert à toutes les teintes. | fait |
| 2.8 | Portraits de face de 64 × 64 px, générés à partir des gènes (teinte, couleurs, formes) et de l'âge (rides, cheveux gris, calvitie). | REN-07 | Un enfant ressemble à ses parents ; un même individu vieillit ; pixel art net, sans mélange de densités. | fait |
| 2.9 | Mini-sprites, première version : de 6 à 10 px de haut, tirés de l'individu (teinte, cheveux, âge, sexe), autour de leur groupe, en vue rapprochée ; une icône de groupe de loin. | REN-04, REN-03, REN-08 | Les sprites suivent leur groupe, à la densité de pixels de la carte, sans faire tomber les images par seconde. | à relire : images/s à mesurer sur appareils |
| 2.10 | Outils : faire apparaître un groupe (espèce, sous-espèce, nombre) ; inspection d'un individu et d'un groupe ; liens familiaux navigables ; chronique de base. | CRE-03, CRE-05, IHM-02, CHR-01 | On fait apparaître un groupe au doigt comme à la souris, on suit ses lignées et on lit sa chronique. | fait |
| 2.11 | Mesures : bancs d'essai à 10 000 et 50 000 individus ; calibrage pour le téléphone. | IND-03, NF-01 | Un pas mensuel de 50 000 individus tient dans le budget de la vitesse la plus rapide sur PC ; la mesure sur téléphone est consignée. | à relire : mesures sur un vrai PC et un vrai téléphone |

### Notes

Les onze tâches sont réalisées, dans les commits « 2.1 … » à « 2.11 … », puis revues par la relecture ci-dessous. Décisions : ADR 0011 ; la phase complète aussi les ADR 0003, 0004, 0007 et 0010. Comme en phase 1, deux critères demandent des appareils réels, hors de portée du conteneur : les images par seconde de 2.9, et le pas mensuel de 2.11 sur un vrai PC et un vrai téléphone ; ces deux tâches restent « à relire » jusqu'à ces mesures.

**Relecture de la phase 2.** Une relecture contradictoire a relevé 84 remarques, en sept domaines : population et sauvegardes, cycle de vie, groupes nomades, assets et portraits, protocole et hôte du worker, interface, exigences et documentation. 80 ont été confirmées par une seconde vérification (5 graves, 25 moyennes, 50 mineures). Toutes sont traitées dans les huit commits « relecture : … » : corrigées, chacune avec un test qui l'aurait détectée ou une vérification dans Chromium, sauf la mesure des images par seconde de 2.9, qui attend de vrais appareils. Les sauvegardes passent en version 5, avec une migration depuis la 4, et le protocole en version 4. Principaux changements :
- **Sauvegardes.** Au-delà de 64 Mio, une longue partie s'écrivait sans erreur, puis ne se relisait plus. La borne passe à 256 Mio, et l'écriture refuse ce que la lecture refuserait, en gardant la sauvegarde précédente. La chronique quitte l'en-tête JSON pour des colonnes. La relecture vérifie chaque tableau avant toute allocation, les identifiants et la chronique, et réécrit l'ascendance quand l'ordre des sous-espèces change (ADR 0007).
- **Cycle de vie.** L'enfant reçoit sa culture selon C2 (D2), et chaque nom de famille garde sa langue. Plus de couples entre oncle ou tante et neveu ou nièce, ni entre beau-parent et bel-enfant. Des mariages entre groupes voisins de cultures différentes font enfin le métissage. Le premier mois de vie a son risque, et les groupes apparus ont des âges et des naissances cohérents. Les paramètres qui restaient dans le code passent dans les données.
- **Groupes nomades et nourriture.** Les groupes passaient entre deux eaux qui se touchent par un coin. Le gibier ne se raréfiait pas l'hiver, et la pêche ne gelait pas comme la carte : l'hiver se fait désormais sentir, et la forêt tempérée nourrit mieux que la toundra (critère de 2.4). À la scission, le meneur reste, et deux groupes vivants n'ont jamais le même meneur : une scission ne donne plus deux groupes du même nom, mais deux meneurs distincts peuvent porter le même prénom. Les fratries orphelines restent ensemble, et le nouveau groupe ne marche qu'une fois.
- **Carte et portraits.** La bannière d'un groupe vu de loin ne mêle plus deux densités de pixels quand la carte le permet, et garde sa taille sur un écran dense. Le portrait s'affiche à un nombre entier de pixels physiques, sur son propre fond, et ses rides se voient. Le nourrisson et l'enfant passent à 6 et 7 px de haut. Les noms n'ont plus trois sons de consonne de suite.
- **Worker et fiches.** Une exception ne fige plus la partie. Les clics sur les liens des fiches ne se perdent plus, et une fiche fermée ne se rouvre plus. Le groupe touché se choisit d'après ce que la carte dessine, à toute échelle. Toute la chronique se consulte, par pages. L'outil d'apparition juge la case touchée de part et d'autre de la couture.
- **Interface.** Au téléphone, un seul panneau à la fois, une feuille au bas de la carte en portrait, et une barre d'outils qui défile. La carte se centre sur sa partie visible. En pause, un groupe apparaît aussitôt. Les fiches prennent le focus et se ferment par Échap. L'outil propose les espèces des données.
- **Contenu en données.** Âges de la vie, confort et rigueurs des espèces, rôles des gènes, formes du visage et du nez passent dans les données : une sous-espèce et un allèle s'y ajoutent sans code, ce qu'un test vérifie.
- **Contrôles et documentation.** L'empreinte d'une population de 3 000 individus est figée dans un test, et le banc d'essai imprime celle de ses scénarios. Les crédits nomment la mortalité de Siler, la transformation de Box et Muller et la spirale de Vogel. La démographie et les mesures de 2.11 sont remesurées.

**Démographie** (tâches 2.3 à 2.5, remesurée après la relecture, puis après celle de ses corrections). Table de Siler des humains, sans rigueur : espérance de vie à la naissance 37,2 ans, survie à 15 ans 58,2 %. Le test « maintient trois siècles durant une population nourrie… » (`src/sim/lifecycle.test.ts`) refait la première ligne du tableau et en borne les résultats : monde Petit, paramètres par défaut ; seize groupes de trente posés par `scatteredGroups` (`src/sim/testing.ts`) sur les terres habitables d'une grille de 8 cases ; sous-espèces à tour de rôle ; 300 ans.

| Graine | Vivants, du premier mois à 300 ans | Groupes à 300 ans | Taille médiane | Croissance | Descendance finale | Espérance de vie vécue | Morts de faim | Deux cultures : couples / naissances |
|---|---|---|---|---|---|---|---|---|
| graine | 479 → 889 | 59 | 15 | 0,21 %/an | 5,27 | 32,2 ans | 801 | 15,7 % / 11,8 % |
| pixelciv | 477 → 2 294 | 157 | 14 | 0,52 %/an | 5,29 | 34,5 ans | 580 | 33,6 % / 27,3 % |
| autre | 476 → 755 | 54 | 14 | 0,15 %/an | 4,62 | 33,8 ans | 419 | 14,0 % / 10,7 % |
| monde | 479 → 2 833 | 191 | 15 | 0,59 %/an | 5,22 | 34,8 ans | 722 | 30,9 % / 25,4 % |

La descendance finale est celle des femmes nées entre les ans 50 et 200 et mortes après 45 ans, la fin de leur période féconde ; l'espérance de vie vécue, l'âge moyen à la mort des mêmes cohortes, froid, faim et couches compris. Ce sont des valeurs de chasseurs-cueilleurs. Ces mesures remplacent celles de la réalisation : 36,5 ans pour la table, que le calcul ne redonnait pas, et 108 groupes en trois siècles, sans graine ni placement consignés.

Depuis la relecture des corrections, les mariages et les réunions entre groupes ne se font plus qu'entre voisins à un mois de marche, sur la même terre (ADR 0011), et le marché des mariages s'en trouve resserré. Avec `pairing` à 0,15, « graine » ne comptait plus que 466 vivants à 100 ans, moins que ses 479 du premier mois, et 657 à 300 ans (0,11 %/an), et « autre » déclinait, de 476 à 432 : le test « maintient trois siècles… » échouait. `pairing`, la probabilité mensuelle qu'une femme seule cherche un conjoint, passe donc à 0,25 (`data/species.json`) ; à 0,2, « graine » n'avait encore que 459 vivants à 100 ans. Le tableau de la relecture donnait, pour les mêmes graines : 479 → 2 163 (153 groupes, 0,50 %/an), 477 → 3 947 (266, 0,70 %/an), 476 → 1 629 (112, 0,41 %/an) et 479 → 4 419 (304, 0,74 %/an).

**Mariage entre cultures.** La dernière colonne du tableau donne la part des couples formés en trois siècles qui unissent deux cultures, puis celle des enfants nés en partie de parents de deux cultures. Une célibataire qui ne trouve de conjoint ni dans son groupe ni dans un groupe voisin de sa culture en cherche un, avec la probabilité `nomads.intermarriage` (0,25, `data/nomads.json`), dans un groupe voisin d'une autre culture : quatre fois moins souvent, chaque mois, qu'elle n'en cherche dans sa culture. Les couples formés par cette voie, comptés dans une copie instrumentée, font de 9 à 23 % des couples selon la graine ; les autres couples entre deux cultures se forment dans le groupe, ou chez un voisin de même culture, où vivent déjà des gens d'une autre culture. Sans ce mariage (`intermarriage` à 0), les mêmes graines comptent 1,9 %, 6,5 %, 0,9 % et 3,8 % de couples entre deux cultures, et 0,8 %, 1,9 %, 0,4 % et 1,3 % de naissances de parents de deux cultures. Elles finissent avec 1 044, 449, 231 et 1 070 vivants, au lieu de 889, 2 294, 755 et 2 833 : « pixelciv » et « autre » déclinent alors, et la population finale est, avec ce mariage, de 0,85 à 5,1 fois celle qu'on a sans lui. La part des naissances de parents de deux cultures ne suit guère la valeur : sur « graine », de 0,05 à 1, elle reste entre 6,5 et 18 %, sans croître avec elle. Le test « maintient trois siècles… » la borne de 5 à 25 % : il voit ce mariage disparaître, mais pas sa valeur changer entre 0,05 et 1.

**Critère de 2.4** (`src/sim/forage.test.ts`, remesuré après la relecture des corrections). Huit groupes de trente nordiques partis de la forêt tempérée, et huit de la toundra, chacun sous son climat, pendant quinze ans : 230 vivants à la fin contre 168, et 12 morts de faim contre 66. Sur deux mondes témoins, toutes leurs terres changées en forêt tempérée puis en toundra, avec le même climat et les mêmes départs : 245 vivants contre 190, et 5 morts de faim contre 53. Au nord de 40°, sur quatorze départs, la réserve moyenne d'un groupe descend de 1,68 mois de besoin en septembre à 1,46 en mars, et la part des mal nourris monte de 0,5 % à 7,1 % ; sur les cases où l'hiver gèle, en forêt tempérée, la réserve descend de 1,82 à 1,07. Les côtes douces restent des refuges d'hiver, où la pêche ne gèle pas (ADR 0011). RES-03 n'est couvert qu'en partie : la cueillette est une vraie ressource, qui s'épuise et se régénère, mais le bois viendra avec la coupe du bois, en phase 3.

**Noms de 2.6** (IND-08). Le nom de famille vient du père, de la mère, des deux, d'aucun, ou c'est un nom obtenu : un surnom propre à chacun, tiré à sa naissance. Le métier et le lieu, autres noms obtenus de C2 (D6), attendent la phase 3. « Les deux » donne le nom du père, puis celui de la mère, chacun dans sa langue, le second omis s'il est le même : c'est la lecture retenue du « mélange des deux » d'IND-08. Un test rend un nom selon chaque règle (`src/sim/records.test.ts`). La règle des consonnes de la relecture change le rendu de 6 à 7 % des noms, y compris dans les parties déjà sauvegardées, qui ne gardent que leurs codes.

**Portraits de 2.8.** Les âges de la vie viennent de l'espèce. L'enfance dure jusqu'à la maturité, 15 ans chez les humains, et un mineur n'a ni barbe, ni calvitie, ni rides. Le gris vient en quatre crans entre 40 et 70 ans : un tiers dès 45 ans, deux tiers dès 55, tout gris dès 65, le même sur la carte et au portrait. La fiche nomme chacun par la classe d'âge de son mini-sprite, et dit « Taille adulte » pour un nourrisson ou un enfant.

**Images par seconde de 2.9 : non mesurées sur un vrai appareil.** Chaque membre visible est un sprite, dans un conteneur trié, avec une texture recolorée par motif, apparence et couleur d'habit. Dans le Chromium sans écran du conteneur, qui dessine en logiciel, en 1280 × 720 sur un monde Petit, au troisième cran de zoom : 41 images/s sans groupe, 25 avec 40 groupes, soit environ 800 mini-sprites (image p95 de 50 ms). Cela ne dit rien d'une vraie carte graphique, mais rien ne montre non plus que le critère tienne. À mesurer avec le panneau de débogage, sur un vrai PC et un vrai téléphone, avec quelques milliers de mini-sprites visibles. Si la mesure le demande, une texture d'atlas par palette garderait le rendu par lots. Les mini-sprites font de 6 à 9 px de haut (nourrisson 6, enfant 7, adulte 9), dans la plage du critère.

**Outils de 2.10.** L'outil d'apparition propose les espèces et les sous-espèces des données, les premières par défaut : « nordique », première de `data/species.json`, et non plus « des plaines », écrite en dur. Armé, il ne compte un appui long qu'au relâcher, s'il n'est devenu ni un glisser ni un pincement. En pause, toucher la carte fait apparaître le groupe aussitôt : il se voit, et la chronique le dit. Un appui sur un groupe ouvre sa fiche, d'après ce que la carte dessine, à toute échelle ; un appui sur une case vide la montre, en laissant ouverte la fiche en cours. La chronique montre les 300 derniers faits, puis les plus anciens à la demande (« Faits plus anciens »), jusqu'au premier. Les fiches prennent le focus sur leur titre, et se ferment par Échap ; le focus revient alors d'où elles s'étaient ouvertes. Au téléphone (au plus 34 rem de large ou 32 rem de haut), la colonne ne montre qu'un panneau à la fois, le dernier ouvert ; en portrait, elle devient une feuille au bas de la carte, et la barre du bas tient sur une ligne qui défile. La carte se centre sur sa partie visible, à l'écart des panneaux.

**Mesures de la tâche 2.11** (`npm run bench`, Node 22, conteneur de développement : processeur de serveur à 2,1 GHz, partagé, dont les durées varient de ±25 % d'un passage à l'autre ; quatre passages après la relecture). Le banc sème des groupes de 25, à 12 cases les uns des autres, sur les terres où l'on vit de la cueillette, et mesure 24 mois après 6 de mise en route. Un pas compte le mois de la simulation et l'image des groupes que le worker envoie à chaque pas. Le budget d'un mois à la vitesse la plus rapide (×16) est de 52 ms.

| Scénario | Groupes | Pas mensuel moyen | Budget à ×16 |
|---|---|---|---|
| 10 000 individus, monde Immense, population qui se maintient (de 9 798 à 10 247 pendant la mesure) | 567 | 17 à 19 ms | tenu |
| 50 000 individus, monde Immense, population qui se maintient (de 48 967 à 49 978 pendant la mesure) | 2 725 | 73 à 77 ms | dépassé de 41 à 48 % |

Avant la relecture, les mêmes scénarios comptaient 660 et 3 300 groupes, pour 16 à 26 et 61 à 87 ms. Le banc échoue si un pas de 10 000 individus dépasse la durée d'un mois à ×16, ou un pas de 50 000 celle d'un mois à ×4 (208 ms). Un monde Grand ne nourrit pas 50 000 chasseurs-cueilleurs : il faut y serrer les groupes à 7 cases pour en loger 2 000, et ils retombent à 32 700 en deux ans. Le coût croît surtout avec le nombre de groupes, de 18 membres en moyenne après les scissions.

Ces mesures précèdent la relecture des corrections, qui compte le voisinage des groupes en temps de trajet. Son effet a été mesuré en alternance avec le commit précédent, trois passages chacun, sur le même conteneur, plus lent ce jour-là. À 10 000 individus, le pas moyen, de 21,6 à 24,3 ms avant, est de 22,0 à 23,6 ms après, avec 577 groupes au lieu de 567 et de 9 798 à 10 293 vivants. À 50 000, il est de 90,1 à 107,6 ms avant et de 99,5 à 104,4 ms après, avec 2 747 groupes au lieu de 2 725 et de 48 944 à 49 987 vivants. Le pas coûte ainsi environ 1 et 5 % de plus. Chronométrées dans le même passage que le pas, les recherches du voisinage prennent 0,45 ms par mois à 10 000 individus, pour 3 recherches, et 5,2 ms à 50 000, pour 30 recherches de 12 groupes candidats en moyenne.

Le banc imprime aussi l'empreinte de l'état au bout des trente mois de chaque scénario : d1b2b057 et bbfbdd8c aujourd'hui, 4b3fcca9 et cb440ea0 avant la relecture des corrections, qui change le déroulement. Les optimisations de la tâche ont été vérifiées ainsi, à 10 000 et 50 000 individus : colonnes lues directement, sans objet par individu ; listes de membres tenues à jour après les fusions et les scissions ; cases entamées marquées et parcourues dans l'ordre des cases ; stocks d'une case côte à côte ; colonnes bouclées sans division. Toute optimisation à venir doit laisser ces empreintes intactes, et celle de trente mois de 3 000 individus que fige `src/sim/state.test.ts`. **À mesurer sur un vrai PC**, plus rapide que ce conteneur : le panneau de débogage donne la durée moyenne des pas, qui compte en plus les faits de la chronique et l'envoi du delta.

**Téléphone, en émulation seulement** (Chromium, fil principal d'une page, monde Moyen, groupes de 25 à 8 cases les uns des autres, 12 mois mesurés après 6 de mise en route ; remesuré après la relecture) :

| Processeur | 10 000 individus | 20 000 individus |
|---|---|---|
| sans ralentissement | 18 ms | 21 ms |
| ralenti 4 fois (milieu de gamme, selon Lighthouse) | 68 ms | 88 ms |
| ralenti 6 fois | 105 ms | 135 ms |

À 10 000 individus, la population se maintient (de 9 764 à 9 634 pendant la mesure) ; à 20 000, le monde Moyen ne la nourrit pas, et elle retombe de 19 510 à 16 964 en un an. Le même scénario donne la même empreinte dans Chromium et sous Node, aux deux tailles. Calibrage proposé pour IND-03 : sur un téléphone de milieu de gamme, de 10 000 à 20 000 individus tiennent la vitesse ×4 (208 ms par mois) ; à ×16, la simulation tourne alors aussi vite qu'elle le peut, sans bloquer l'interface (NF-02). **À confirmer sur un vrai téléphone.**

**Sprites et portraits.** Les mini-sprites, la bannière de groupe et les portraits sont dessinés pour le jeu (sources en grilles de texte dans `assets/pixel/`, portraits générés) : le pack de GandalfHardcore n'est pas versé, sa licence restant à vérifier (voir ci-dessous).

**Écarts et reports** (détails dans l'ADR 0011) :
- IND-08 et C2 (D6) : le nom obtenu n'est encore qu'un surnom ; le métier et le lieu attendent la phase 3. Dans un couple mixte, l'enfant d'une culture à la règle « père » hérite du surnom de son père, qui devient un nom de famille.
- RES-03 : le bois attend la coupe du bois, en phase 3.
- REN-04 : les mini-sprites montrent le sexe, l'âge, le teint, les cheveux et l'habit de la culture ; le rang, le métier et l'équipement viendront avec eux.
- REN-08 : la bannière d'un groupe vu de loin devient, quand la carte est trop fine, un marqueur d'interface de taille fixe (ADR 0010).
- À soumettre à l'auteur : une saison de la pêche hors de la glace, pour que l'hiver pèse aussi sur les côtes douces ; l'interdit de conception qui suit un accouchement (`fertility.postpartum`), qui tient même quand le nourrisson meurt : le lever relèverait sensiblement la fécondité ; `pairing`, porté de 0,15 à 0,25 à la relecture des corrections, pour que la démographie croisse encore quand les mariages entre groupes n'unissent plus que des voisins à un mois de marche ; et le mariage entre cultures, dont la probabilité, `nomads.intermarriage` à 0,25, est une valeur proposée à la relecture de la phase 2, à valider : dans la démographie ci-dessus, avec elle, de 14 à 34 % des couples unissent deux cultures et de 11 à 27 % des naissances ont des parents de deux cultures, contre 0,9 à 6,5 % et 0,4 à 1,9 % sans elle ; la population finale est de 0,85 à 5,1 fois celle qu'on a sans elle.

Restent ouverts :
- les images par seconde de 2.9 et le pas mensuel de 2.11, sur de vrais appareils ;
- le journal des commandes, l'archive des morts et la chronique grossissent sans fin : il faudra les compacter (ADR 0007, ADR 0011) ;
- un mois interrompu par une exception laisse l'état à moitié avancé, et un rejeu en divergerait (ADR 0004) ;
- l'auto-test du déterminisme, dans le navigateur, ne couvre pas la population (ADR 0003) ;
- le rendu reconnaît encore le lit des fleuves à l'identifiant de son biome (ADR 0010) ;
- au portrait, le coin de l'œil des tout-petits aux visages étroits prend la couleur du contour, comme avant la relecture ; aux densités d'écran non entières, Chromium adoucit son bord extérieur ;
- au téléphone en paysage, la largeur de la barre du bas repose sur `:has()` ; un panneau caché sous un autre n'est pas annoncé, et Échap ne ferme un panneau que si le focus est en lui ;
- le bloc principal du build dépasse les 500 ko au-delà desquels Vite avertit (510 ko).

## À fournir par l'auteur

| Quoi | Pour | Référence | État |
|---|---|---|---|
| Notebook `testMap_filtre.ipynb` | simple illustration pour la phase 1, qui s'appuie sur C1 et ses images | PLAN, section 12, étape 1 | non reçu |
| Notebooks `testArmoiries.ipynb` et `testVisages.ipynb`, simples illustrations : portraits et armoiries sont conçus à neuf | phases 2 et 4 | PLAN, version 0.3 | non reçus |
| Scripts de la séance C1, dans `prototypes/c1/` | phase 1, dont ils sont l'implémentation de référence | PLAN, sections 6 et 12 (étape 4) | versés |
| Images de la séance C1, dans `docs/design/C1/` : `avant-apres-tropiques.png`, `avant-apres-nord.png`, `saisons-nord.png` | phase 1 | PLAN, section 12, étape 4 | versées, converties depuis les pièces jointes (256 couleurs) |
| Animation `docs/design/C1/saisons.gif`, à laquelle renvoie `C1-monde.md` | phase 1 | PLAN, section 12, étape 4 | seule sa première image est arrivée, versée sous `saisons-janvier.png` |
| Document de la séance C2, `docs/design/C2-peuples.md` | phases 2 à 4, puis 9 | PLAN, section 12, étape 4 | versé ; transmis comme `docs/design/C2/C2-peuples.md`, il est rangé à côté de `C1-monde.md`, où le PRD, le plan et ses propres liens d'images l'attendent |
| Scripts de la séance C2, dans `prototypes/c2/` : `villages.py`, `territoires.py` | phase 3, dont ils sont l'implémentation de référence | PLAN, sections 7 et 12 (étape 4) | versés |
| Images de la séance C2, dans `docs/design/C2/` : `score.png`, `expansion.png`, `zoom.png`, `territoires.png` | phase 3 | PLAN, section 12, étape 4 | versées, converties depuis les pièces jointes (256 couleurs) |
| Pack de sprites : « 2D Pixel Art Male and Female Character », de GandalfHardcore, version gratuite | phase 2 et suivantes | AST-01, AST-02 ; PRD, question 14 | auteur et lien reçus ; licence à vérifier, `itch.io` étant hors de portée de la session ; non versé |
| Activation de GitHub Pages, avec « GitHub Actions » comme source | 0.3 | PLAN, section 12, étape 2 | faite : le déploiement de `main` a réussi |
