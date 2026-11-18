# Plan de développement — Jeu de simulation de mondes et de vies

Version 0.6 · 11 novembre 2026 · complète le PRD (`docs/PRD.md`, version 0.5)

Historique : 0.1, première version ; 0.2, intégration de la séance C1 sur le monde ; 0.3, générateurs de portraits et d'armoiries conçus à neuf, portraits d'environ 64×64 px ; 0.4, ADR de la phase 0 et dossier `src/worker/` (tâche 0.2) ; 0.5, intégration de la séance C2 sur les peuples et les établissements ; 0.6, lot « Population » de la phase 2 aligné sur l'ADR 0011 : les emplacements sont recyclés, les identifiants restent stables (relecture de la phase 2).

## 1. Principes

Le PRD dit ce que le jeu doit faire ; ce plan dit comment le construire et dans quel ordre.

| Principe | En pratique |
|---|---|
| Des jalons jouables | Chaque phase se termine par une version jouable, déployée automatiquement et testable sur PC comme sur téléphone. |
| Le MVP d'abord | Les phases 0 à 4 livrent le mode Créateur minimal, c'est-à-dire le périmètre P0 du PRD. |
| Une Saga tôt, enrichie au fil de l'eau | Le mode Saga arrive juste après le MVP avec son interface de base ; chaque système ajouté ensuite apporte son onglet (SAG-05). |
| Concevoir avant de coder | Les systèmes complexes sont précédés d'une séance de conception dans la conversation de design ; elle produit un document dans `docs/design/`. |
| Une simulation testable seule | Le cœur de la simulation est du TypeScript sans DOM, déterministe, testé sous Node. |
| Mesurer plutôt que deviner | Bancs d'essai de performance dès la phase 2, calibrage sur un vrai téléphone. |

## 2. Organisation du travail

### Rôles

| Qui | Rôle |
|---|---|
| Toi | Direction, arbitrages, relecture des PR, tests sur PC et téléphone, contenu (événements, textes). |
| Claude Code | Implémentation dans le dépôt : code, tests, tickets, PR. |
| Conversation de conception (claude.ai) | Séances de conception, mises à jour du PRD et du plan, prototypes ponctuels publiés en lien. |

### Dépôt public

Le dépôt public apporte deux avantages : l'hébergement gratuit des versions de test sur GitHub Pages, et la lecture du code depuis la conversation de conception. Il impose trois précautions :
- **Licence du code.** Sans fichier de licence, le code reste sous droits réservés, ce qui garde la porte ouverte à une sortie commerciale. Une licence libre ne s'ajoute que par choix délibéré.
- **Pack de sprites.** Il n'est versé dans le dépôt que si sa licence autorise la redistribution des fichiers. Sinon, il reste en local, dans un dossier ignoré par git.
- **Secrets.** Aucun secret (clé, jeton, mot de passe) n'est jamais versé.

### Arborescence

```
CLAUDE.md          consignes lues par Claude Code à chaque session
docs/              PRD.md, PLAN.md, BACKLOG.md, design/ (séances de conception), decisions/ (ADR)
prototypes/        notebooks et scripts Python d'exploration
assets/source/     pack de sprites original, licence et crédits (si redistribuable)
assets/pixel/      sources pixel art éditables (meubles héraldiques, motifs, tuiles)
data/              contenu du jeu en JSON (biomes, espèces, savoirs, biens, titres, événements…)
src/core/          utilitaires partagés : PRNG, maths déterministes, protocole, types
src/worldgen/      génération du monde
src/sim/           simulation, exécutée dans un Web Worker
src/worker/        hôte de la simulation dans le worker : messages, cadence des pas, mesures
src/gen/           générateurs procéduraux : portraits, armoiries, noms, mini-sprites…
src/render/        rendu PixiJS
src/ui/            interface Preact
src/i18n/          traductions
src/app/           point d'entrée et orchestration
tools/             scripts : pipeline d'assets, validation des données, bancs d'essai
```

### Flux de travail

Chaque phase correspond à un jalon GitHub (milestone) et chaque tâche à un ticket. Le cycle d'une tâche est le suivant :
1. Claude Code traite le ticket sur une branche dédiée et ouvre une PR, avec tests, vérification des types et lint au vert.
2. Tu relis et testes, puis tu fusionnes.
3. La fusion sur `main` déploie automatiquement la version sur GitHub Pages, que tu peux ouvrir sur ton téléphone.

En développement, le serveur local (`npm run dev`) est aussi accessible depuis le téléphone, sur le réseau local.

Les conventions de code tiennent en trois règles :
- identifiants en anglais, commentaires et documentation en français ;
- TypeScript strict ;
- textes affichés en français, mais toujours via le système de traduction.

Une tâche est finie quand :
- tests, vérification des types et lint passent ;
- la logique nouvelle de simulation ou de génération est couverte par des tests ;
- les textes passent par la traduction et le contenu vient de `data/` ;
- la fonctionnalité marche sur PC et sur téléphone, au doigt, en paysage comme en portrait ;
- les faits notables qu'elle produit apparaissent dans la chronique ;
- les documents concernés (PRD, plan, ADR, design) sont à jour.

## 3. Architecture

Les décisions d'architecture sont consignées dans `docs/decisions/` : pile technique (ADR 0001), monde cylindrique (ADR 0002), déterminisme (ADR 0003) et communication avec le worker (ADR 0004). L'index de ce dossier recense les suivantes.

### Vue d'ensemble

```
┌───────────── Fil principal ─────────────┐   messages    ┌──────── Worker de simulation ────────┐
│ Interface : Preact, HTML et CSS         │ ────────────► │ État du monde (tableaux typés)        │
│ Rendu : PixiJS (carte par blocs,        │  commandes    │ Systèmes : démographie, économie,     │
│         sprites, superpositions)        │               │ politique, guerre…                    │
│ Entrées : souris, clavier, tactile      │ ◄──────────── │ Générateurs, PRNG, chronique          │
└─────────────────────────────────────────┘ instantanés,  └───────────────────────────────────────┘
                                             deltas, blocs
```

Le fil principal affiche et réagit ; le worker possède l'état du monde et fait avancer le temps.

Le fil principal envoie des commandes : créer un monde, faire apparaître des individus, modifier une entité, régler la vitesse… Le worker renvoie des instantanés et des deltas : blocs de carte modifiés, positions, entités inspectées, nouvelles entrées de chronique. Les gros volumes voyagent sous forme de tampons transférés, sans copie.

Le `SharedArrayBuffer` est exclu, parce qu'il exige des en-têtes HTTP que GitHub Pages ne permet pas de définir.

### Simulation

| Sujet | Choix |
|---|---|
| Temps | Pas de temps mensuel. Les systèmes s'exécutent dans un ordre fixe, chacun à sa fréquence (mensuelle, saisonnière, annuelle). |
| Commandes | Horodatées et appliquées au début d'un pas : rejouer une partie revient à rejouer ses commandes. |
| Individus | Les individus ordinaires sont stockés en tableaux typés, une colonne par attribut. Les notables sont enrichis par des objets. Les identifiants sont des entiers recyclés. |
| Relations | Tables de liaison pour les relations multiples : civilisation et cultures, individu et langues, etc. |
| Monde | Chaque couche de la grille est un tableau typé (altitude, biome, propriétaire, routes…). Les blocs modifiés sont marqués pour le rendu. |
| Historique | Chronique en journal compact ; les morts sont archivés sous forme compacte. |
| Contenu | Chargé depuis `data/`. Les identifiants textuels sont convertis en indices entiers au chargement. |

### Déterminisme

Une même graine doit donner le même monde sur tous les appareils (NF-09). Trois règles en découlent :
- **Aléatoire.** La simulation, la génération et les générateurs n'utilisent que le PRNG du projet, découpé en flux nommés (un flux par système). Ils n'utilisent jamais `Math.random` ni l'heure.
- **Fonctions mathématiques.** La norme JavaScript laisse aux moteurs le soin d'approcher `Math.sin`, `Math.exp`, `Math.log` ou `Math.pow`, et leurs résultats peuvent différer d'un navigateur à l'autre. Les calculs qui influencent l'état s'en tiennent donc aux opérations arithmétiques de base, à `Math.sqrt`, `Math.floor`, `Math.abs`, `Math.min` et `Math.max`, ou passent par des implémentations maison.
- **Tests.** Des tests comparent l'empreinte de l'état après N pas à une valeur de référence.

### Rendu

**Blocs de carte.** La carte est découpée en blocs de 64×64 cases, soit 256×256 px. Les blocs sont cuits dans un worker en reprenant l'algorithme du prototype (tuiles, débordement du relief, shader), puis affichés comme textures. Seuls les blocs modifiés sont recuits. Si la mémoire devient un problème sur mobile, on garde en réserve une alternative : un rendu entièrement sur la carte graphique, à partir de textures de données.

**Couture est-ouest.** Les blocs sont dessinés modulo la largeur du monde, et la caméra boucle.

**Pixel art net.** L'échantillonnage se fait au plus proche, les positions à l'écran sont entières, et les forts grossissements procèdent par paliers entiers pour éviter le scintillement.

**Couches.** Les niveaux de détail s'affichent selon des seuils de zoom. Les sprites sont dessinés par lots. Frontières et modes de carte sont des superpositions séparées.

### Interface

L'interface est en Preact, avec des signaux pour la réactivité. Elle s'affiche par-dessus le canvas et s'adapte du paysage au portrait. Les gestes tactiles (pincer, glisser, appui long) passent par les événements de pointeur.

La traduction repose sur un petit système maison : des clés, des pluriels, et le genre pour les titres (baron, baronne).

### Données, sauvegardes et générateurs

**Données.** Le contenu est en JSON, décrit par des schémas Zod et validé au démarrage et dans l'intégration continue.

**Sauvegardes.** Une sauvegarde réunit les tableaux typés en binaire et les tables des notables en JSON, compressés. Elle est stockée dans IndexedDB et peut être exportée ou importée sous forme de fichier. Le format est versionné et accompagné de migrations.

**Générateurs.** Ce sont des fonctions pures : une graine et des paramètres donnent toujours le même résultat, mis en cache. Il y en a d'abord pour les portraits, les armoiries (avec la nouvelle saisie des meubles), les noms et les langues, et les mini-sprites. Viendront ensuite l'architecture, les œuvres et les écrans de visualisation.

**Pipeline d'assets.** Les sources éditables de `assets/pixel/` sont des images indexées par rôle de teinte ou des grilles de texte. Un script de `tools/` en tire des atlas et leurs descriptions JSON, et la recoloration se fait à l'exécution.

### Dépendances proposées

| Bibliothèque | Usage | Licence |
|---|---|---|
| Vite | serveur de développement et build | MIT |
| TypeScript | langage | Apache 2.0 |
| PixiJS (v8) | rendu WebGL | MIT |
| Preact et @preact/signals | interface | MIT |
| Zod | schémas des données | MIT |
| Vitest | tests et bancs d'essai | MIT |
| ESLint et Prettier | qualité et format du code | MIT |
| vite-plugin-pwa (phase 4) | application installable et hors ligne | MIT |

Le bruit simplex est écrit dans le projet, pour en maîtriser le déterminisme. Les versions sont épinglées par le fichier de verrouillage.

## 4. Vue d'ensemble des phases

| Phase | Contenu | Jalon jouable | Taille |
|---|---|---|---|
| 0 | Socle technique | Une coquille déployée : grille de test qui boucle, zoom, temps, sauvegarde | M |
| 1 | Génération du monde | Générer et explorer un monde cylindrique | L |
| 2 | Individus et démographie | Les premiers humains vivent, ont des enfants et meurent | L |
| 3 | Villages, civilisations et cultures | Des villages naissent, grandissent et inventent | L |
| 4 | Gouvernements, armoiries et premières guerres | **MVP du mode Créateur (P0)** | L |
| 5 | Saga, première version | Vivre une vie, puis celle d'un héritier | L |
| 6 | Savoirs et artisanat | L'âge des inventions et des manufactures | L |
| 7 | Économie de marché | Marchés, marchands, banques et rentiers | XL |
| 8 | Politique et féodalité | Couronnes, républiques et parlements | XL |
| 9 | Cultures, langues, religions et arts | Des dieux, des langues et des chefs-d'œuvre | XL |
| 10 | Guerre | Batailles tactiques visibles et commandables | XL |
| 11 | Écrans de visualisation | Voir le monde de près : paysages, villes, batailles | L |
| 12 | Mode Libre et finitions | **Version 1 (P1)** | M |

Les tailles sont relatives : S < M < L < XL, et chaque cran double à peu près l'effort. On les recalibrera après les phases 0 et 1, une fois le rythme réel connu.

## 5. Phase 0 — Socle technique

Objectif : un projet outillé, testé et déployé automatiquement, avec l'architecture en place (fil principal, worker, protocole, temps, caméra, traduction, données, sauvegarde), avant tout contenu de jeu.

| # | Tâche | Exigences | Critère d'acceptation |
|---|---|---|---|
| 0.1 | Projet Vite et TypeScript strict, arborescence, ESLint, Prettier, Vitest ; scripts `dev`, `build`, `test`, `typecheck`, `lint` ; licences des dépendances vérifiées. | NF-11, AST-05 | `npm test` et `npm run build` passent. |
| 0.2 | Documentation : PRD et plan dans `docs/` ; premiers ADR (pile technique, monde cylindrique, déterminisme, communication avec le worker) ; relecture de `CLAUDE.md`. | — | ADR rédigés et cités dans le plan. |
| 0.3 | Intégration continue GitHub Actions (lint, types, tests, build) et déploiement sur GitHub Pages à chaque fusion sur `main`. | — | Chaque PR affiche ses vérifications ; `main` est en ligne. |
| 0.4 | Squelette d'application : page plein écran, canvas PixiJS, couche d'interface Preact, redimensionnement, orientation, zones de sécurité des téléphones. | IHM-06, IHM-07 | Affichage correct en paysage et en portrait. |
| 0.5 | Worker de simulation et protocole de messages typé : commandes, instantanés, deltas, tampons transférés. Une seule simulation pour tous les modes. | NF-02, MOD-01 | Un pas factice de 200 ms ne fait pas chuter l'affichage. |
| 0.6 | Boucle de temps : pas mensuel, calendrier, pause, plusieurs vitesses, horodatage des commandes. | MOD-06 | Une année dure environ 10 s en vitesse normale. |
| 0.7 | PRNG à flux nommés et maths déterministes (`src/core/rng.ts`, `src/core/dmath.ts`). | NF-09 | Même graine, même suite, sous Node comme dans les navigateurs. |
| 0.8 | Caméra : déplacement et zoom à la souris, au clavier et au doigt, sur une grille de test qui boucle d'est en ouest. | MON-01, IHM-07 | Défilement sans fin, sans saut à la couture. |
| 0.9 | Traduction : clés, fichier français, pluriels et genre ; un test échoue si une clé manque. | NF-06, POL-04 | Aucun texte en dur dans le squelette. |
| 0.10 | Données : chargement et validation par schémas ; premier fichier `data/biomes.json` (biomes du prototype) ; validation en intégration continue. | NF-07, MON-10 | Une donnée invalide fait échouer l'intégration continue. |
| 0.11 | Sauvegarde minimale : IndexedDB, format versionné, export et import de fichier. | NF-05 | Une partie factice survit à un rechargement et passe d'un appareil à l'autre. |
| 0.12 | Panneau de débogage : images par seconde, durée des pas, mémoire. | NF-01 | Visible sur PC et téléphone. |
| 0.13 | Prototypes dans `prototypes/`, pack de sprites dans `assets/source/` si sa licence le permet, fichier `CREDITS.md`. | AST-01, AST-02 | Crédits renseignés. |

**Jalon 0.** Sur PC et sur téléphone, une grille de test qui boucle d'est en ouest, zoomable, avec contrôle du temps, panneau de débogage et sauvegarde.

## 6. Phase 1 — Génération du monde

Objectif : porter le pipeline du prototype en TypeScript, sur un monde cylindrique, avec un rendu fidèle et fluide, en y intégrant les corrections de la séance C1 (relief, climat, eaux, côtes, saisons).

Séance préalable : C1, tenue le 8 novembre 2026. Ses décisions D1 à D13 font foi pour cette phase (`docs/design/C1-monde.md`), et `prototypes/c1/` en donne une implémentation de référence.

| # | Tâche | Exigences | Critère d'acceptation |
|---|---|---|---|
| 1.1 | Bruit simplex 3D déterministe et échantillonnage sur un cylindre : la longitude devient un angle, et la carte se referme d'est en ouest. | MON-01, MON-04 | Valeurs continues à la couture ; même graine, même bruit. |
| 1.2 | Relief : bruit fractal à trois échelles, comme dans le prototype, plus des chaînes de montagnes par bruit de crêtes (D12). Paramètres : niveau de la mer, part des terres, relief. Correspondance en mètres et 20 niveaux d'altitude (D11). | MON-03, MON-05, MON-14 | 3 à 6 % des terres au-dessus de la moyenne montagne ; crêtes continues, avec des cols. |
| 1.3 | Climat : températures recalibrées, gradient de 6,5 °C par 1 000 m ; précipitations par bandes de latitude, vents dominants et ombre pluviométrique ; continentalité ; températures mensuelles (D8, D13). | MON-04, MON-15, SAI-01, SAI-02 | Environ 27 °C à l'équateur et −25 °C aux pôles ; présence de déserts subtropicaux et de déserts d'abri. |
| 1.4 | Hydrologie continue d'est en ouest. Un seul niveau de la mer, et un océan limité aux eaux reliées à l'océan mondial (D1). Remplissage avec pente minimale sur les plats, puis accumulation. Lacs par bilan hydrique (D2) et trois classes de rivières (D3). L'alias du prototype est corrigé. | MON-04, MON-07, MON-11 | Toute rivière rejoint la mer ou un lac ; aucune n'est coupée à la couture, ni rectiligne. |
| 1.5 | Les 32 biomes naturels (D6), décrits dans `data/biomes.json` et classés selon le mois le plus chaud et le plus froid (D13). Côtes typées (D4) et zones humides (D5). | MON-08, MON-10, MON-12, MON-13 | Plages sur une seule rangée côtière ; glaciers seulement là où le mois le plus chaud reste sous 0 °C. |
| 1.6 | Ressources et flore : gisements selon l'altitude et le biome, ressources des milieux humides et salés, densités d'arbres et de buissons. | RES-01, RES-03, RES-05 | Répartition lisible en mode de carte « ressources ». |
| 1.7 | Cuisson des blocs dans un worker : tuiles de 4 px avec variations, débordement du relief, shader (pente, lumière du nord-est, teinte thermique). Texture de données des saisons, une valeur par case (D10). | REN-01, REN-02, REN-09, REN-10 | Rendu fidèle au prototype, sans couture visible. |
| 1.8 | Affichage : zoom net, niveaux de détail de base, modes de carte « relief », « biomes » et « ressources » avec légende. Neige et glace saisonnières, par shader et palettes saisonnières (D10). | REN-03, REN-08, REN-10, IHM-01 | 60 images/s sur PC et 30 sur téléphone, sur une carte Grand, saisons comprises. |
| 1.9 | Écran de création : graine, taille, paramètres, aperçu, régénération. | CRE-01, MON-02 | Utilisable au doigt sur téléphone. |
| 1.10 | Tests et bancs d'essai : empreinte des cartes par graine, continuité de la couture, durée de génération par taille. | NF-03, NF-09 | Un monde Grand se génère en moins de 10 s sur PC ; la mesure sur téléphone est consignée. |

**Jalon 1.** On génère un monde cylindrique à partir d'une graine, avec ses montagnes, ses lacs, ses côtes et ses climats. On l'explore sur PC et sur téléphone pendant que les saisons passent.

## 7. Phases 2 à 4 : jusqu'au MVP

### Phase 2 — Individus et démographie

Objectif : une population qui vit, se reproduit, transmet ses gènes et meurt, et qu'on peut observer.

| Lot | Contenu | Exigences |
|---|---|---|
| Population | Stockage en tableaux typés, emplacements recyclés et identifiants stables, archivage des morts. | IND-01, IND-03 |
| Génétique | Génome compact, allèles dominants et récessifs, traits polygéniques, mutations. | IND-05, IND-06 |
| Cycle de vie | Âges, mortalité et fertilité par espèce, couples, naissances ; adaptations des sous-espèces humaines ; métissage. | IND-04, ESP-01 à ESP-04 |
| Survie | Faim, cueillette, chasse, pêche, avec des rendements saisonniers et une mortalité hivernale (D9) ; faune chassable. | ECO-11, RES-03, RES-04, FAU-01, SAI-03 |
| Groupes nomades | Les humains apparus sans civilisation forment des groupes, avec langue et culture embryonnaires dès leur apparition ; ils se déplacent au fil des saisons, à environ 30 cases par mois, et se scindent au-delà d'une trentaine de membres (C2, D4 et D13). | CIV-05, MON-16 |
| Noms | Phonologie générée, prénoms et noms de famille. | LAN-01, IND-08 |
| Visuels | Pipeline d'assets (sources éditables, atlas, recoloration) ; générateur de portraits d'environ 64×64 px, piloté par les gènes et l'âge ; mini-sprites, première version. | AST-03, AST-04, REN-07, REN-04 |
| Outils | Apparition d'individus, panneau d'inspection, liens familiaux, chronique de base. | CRE-03, CRE-05, IHM-02, CHR-01 |
| Mesures | Bancs d'essai à 10 000 et 50 000 individus, sur PC et sur téléphone ; calibrage mobile. | IND-03, NF-01 |

**Jalon 2.** On fait apparaître un groupe d'humains. Il nomadise au fil des saisons, survit ou non, et ses enfants ressemblent à leurs parents. On suit les lignées.

### Phase 3 — Villages, civilisations et cultures

Objectif : des peuples qui se sédentarisent, transforment le paysage et inventent leurs premières techniques.

Séance préalable : C2, tenue le 9 novembre 2026. Ses décisions D1 à D14 font foi pour cette phase (`docs/design/C2-peuples.md`), et `prototypes/c2/` en donne une implémentation de référence.

| Lot | Contenu | Exigences |
|---|---|---|
| Peuples | Fondation des civilisations ; relation libre entre civilisations et cultures, dérivée des individus et des villages ; appartenance ; caractéristiques initiales et traits culturels. | CIV-01, CIV-03, CIV-04, CIV-06, CUL-01 |
| Établissements | Score d'emplacement ; croissance d'abord et défrichement progressif ; tailles, de hameau à bourg ; abandon ; chef provisoire. | VIL-01, VIL-02, VIL-05, POL-01 |
| Territoires | Territoires organiques par coût de déplacement depuis les bâtiments, recalculés localement ; sentiers tracés au moindre coût entre villages voisins. | VIL-03, MON-16 |
| Colonies | Essaimage des villages saturés, à 22 à 40 cases, à pied ou en barque. | VIL-04 |
| Terrain | Occupation du sol en couche distincte (C1, D7) : grandes cultures, pâturages, coupes, friches et zones bâties, avec la succession écologique. | TER-01, TER-03, MON-09 |
| Travail | Métiers et compétences ; production de subsistance, avec semailles et récoltes saisonnières (C1, D9) ; stocks ; patrimoine individuel. | IND-07, ECO-01, ECO-02, ECO-09, SAI-03 |
| Premiers savoirs | Les onze premiers savoirs en données, dont l'élevage ; invention par le métier qui porte chaque savoir ; savoirs de départ selon le milieu. | SAV-01, SAV-02, SAV-05, SAV-09 |
| Architecture | Bâtiments selon les savoirs et la culture dominante ; niveaux de détail intermédiaire et rapproché. | ARC-01, REN-03 |
| Langues et noms | Lexique de 30 racines pour les noms de lieux ; noms des civilisations et des cultures. | LAN-01, LAN-02, LAN-05 |
| Carte et chronique | Modes de carte « politique », « civilisations » et « cultures » ; fondations, colonies, inventions et abandons dans la chronique. | IHM-01, CHR-01 |

**Jalon 3.** Des groupes se fixent et fondent des civilisations. Leurs villages grandissent, défrichent, tracent des sentiers et essaiment quand ils sont à l'étroit. Ils transforment le paysage et inventent leurs premières techniques.

### Phase 4 — Gouvernements, armoiries et premières guerres : le MVP

Objectif : compléter le périmètre P0 du PRD et livrer un mode Créateur minimal, installable et jouable hors ligne.

Séance préalable : C3, sur les gouvernements (type et mode d'accès, dictature, anarchie, titres).

| Lot | Contenu | Exigences |
|---|---|---|
| Gouvernements | Type et mode d'accès ; niveaux 1 et 2 ; nomenclature en données ; monarchie et hérédité ; territoires des gouvernements et frontières politiques, issus des territoires des établissements ; vassalité de base. | POL-01 à POL-05, POL-15 |
| Maisons et armoiries | Maisons notables ; générateur d'armoiries, avec la nouvelle saisie des meubles ; règles héraldiques. | FAM-01, HER-01, HER-02, HER-05 |
| Guerre | Déclaration, levée de vrais soldats, organisation simplifiée, déplacement des armées, résolution automatique, occupation, paix. | DIP-01, MIL-01, MIL-03, MIL-04, MIL-08 |
| Créateur | Pinceaux de terrain, modification des entités. | MOD-02, CRE-02, CRE-04 |
| Finitions | Chronique filtrable ; sauvegardes complètes ; application installable et hors ligne ; ergonomie mobile. | CHR-02, NF-04, NF-05, IHM-06, IHM-07 |
| Robustesse | Test de longue durée : 300 ans sans plantage, sans valeur aberrante, avec des invariants démographiques respectés. | NF-10 |

**Jalon 4, le MVP.** Toutes les exigences P0 du PRD sont satisfaites (PRD, section 26).

## 8. Phases 5 à 12 : vers la version 1

### Phase 5 — Saga, première version

Séance préalable : C4, sur le contrôle direct, les carrières et le format des événements.

Contenu :
- naissance au choix ou tirée au sort, dans un monde pré-simulé (SAG-01, MOD-03, MOD-05) ;
- contrôle mixte et contrôle direct de base (SAG-02, SAG-03) ;
- interface de base (SAG-04) et carrières disponibles à ce stade (SAG-06) ;
- système d'événements et premier contenu (EVT-01, EVT-02) ;
- mariage (IND-09) et notables, première version (IND-02) ;
- mort, choix de l'héritier et testament, première version (SAG-07, SAG-08) ;
- arbre généalogique (IHM-03) et prestige dynastique (SAG-09).

**Jalon 5.** Naître, vivre, mourir, et continuer avec un enfant ou un proche.

### Phase 6 — Savoirs et artisanat

Séance préalable : C5, sur l'arbre des savoirs.

Contenu :
- arbre complet par domaines, diffusion entre voisins, maîtrise et âges sombres, régimes débloqués, plafond technologique (SAV-01, SAV-03, SAV-04, SAV-06, SAV-07) ;
- manufactures (ECO-02) et domestication (FAU-02) ;
- assèchement des marais (MON-13), et occupations du sol liées aux savoirs : bocage, cultures irriguées, terrasses, vergers et vignes, carrières et mines (MON-09) ;
- architecture assemblée par éléments (ARC-02) et habillage évolutif de l'interface (IHM-05) ;
- onglet Saga « Recherche ».

**Jalon 6.** L'âge des inventions, jusqu'aux premières manufactures.

### Phase 7 — Économie de marché

Séance préalable : C6, sur l'économie.

Contenu :
- marchés et prix, commerce par route, rivière et mer (ECO-03, ECO-04, MON-07) ;
- monnaie et banques, assurances, entreprises, immobilier (ECO-05 à ECO-08) ;
- finances publiques, fiscalité et politiques publiques (ECO-10, POL-12, POL-13) ;
- gisements épuisables et salines (RES-02, RES-05), ruines (TER-03), bonnes et mauvaises années (SAI-04) ;
- mode de carte « économie » ;
- onglets Saga « Entreprise » et « Immobilier ».

**Jalon 7.** Marchés, marchands, banques et rentiers.

### Phase 8 — Politique et féodalité

Séance préalable : compléments de la séance C3.

Contenu :
- tous les types et modes d'accès, niveaux 1 à 5, élections et conseils (POL-02 à POL-08) ;
- vassalité complète, lois de succession et d'héritage, institutions (POL-09, POL-11, POL-14) ;
- notables complets (IND-02) et diplomatie complète (DIP-02) ;
- écartelé et brisures, modification des armoiries par le joueur (HER-03, HER-06) ;
- statistiques et graphiques (CHR-03, IHM-04) ;
- onglet Saga « Gouverner ».

**Jalon 8.** Couronnes, républiques et parlements.

### Phase 9 — Cultures, langues, religions et arts

Séance préalable : C7, sur la diffusion et les religions.

Contenu :
- scissions et diffusion des civilisations et des cultures (CIV-02, CUL-02, CUL-03) ;
- lexique de racines et familles de langues (LAN-02, LAN-03) ;
- religions, dont la foi en Le Créateur, et ordres religieux (REL-01 à REL-06, CRE-06, FAM-02) ;
- œuvres et arts du spectacle (ART-01, ART-03, ART-04) et blasonnement automatique (HER-04) ;
- fêtes et rites saisonniers, calendriers locaux (SAI-04, SAI-05) ;
- modes de carte « religion » et « langue » ;
- onglets Saga « Religion » et « Œuvres ».

**Jalon 9.** Des dieux, des langues et des chefs-d'œuvre.

### Phase 10 — Guerre

Séance préalable : C8, sur le système de batailles.

Contenu :
- organisations terrestre et navale complètes (MIL-01, MIL-02) ;
- couche stratégique et doctrines (MIL-04, MIL-05) ;
- batailles tactiques et commandement par grade (MIL-06, MIL-07) ;
- terrains ravagés et rapports de bataille (MIL-09, TER-02) ;
- effets des saisons sur la guerre : saison de campagne, attrition hivernale, boue, eaux gelées, tempêtes (SAI-04) ;
- effets défensifs du relief (MON-06) ;
- onglet Saga « Armée ».

**Jalon 10.** Des batailles tactiques visibles et commandables.

### Phase 11 — Écrans de visualisation

Séance préalable : C9, sur les écrans de visualisation.

Contenu :
- écrans de paysage, de ville et de bataille (REN-05, REN-06) ;
- tableaux et enluminures générés (ART-02) ;
- couleurs saisonnières de la végétation (REN-10) ;
- secondes versions des mini-sprites et des portraits, avec vêtements selon la culture et le rang (REN-04, REN-07).

**Jalon 11.** Voir le monde de près.

### Phase 12 — Mode Libre et finitions

Contenu :
- mode Libre (MOD-04, LIB-01) ;
- écran de crédits (IHM-08) ;
- migrations de sauvegardes et robustesse sur plusieurs siècles (NF-05, NF-10) ;
- performances sur mobile, équilibrage, préparation de l'empaquetage.

**Jalon 12, la version 1.** Toutes les exigences P1 du PRD sont satisfaites.

## 9. Au-delà de la version 1

Ce sont les exigences P2 du PRD :
- autres espèces et monstres (ESP-05, ESP-06) ;
- batailles navales (MIL-10) et catastrophes (CRE-07) ;
- érosion et marées (TER-04, TER-05) ;
- complots et assassinats (POL-10) et ordres militaires (FAM-03) ;
- styles héraldiques (HER-07), emprunts entre langues (LAN-04) et branches de savoirs propres aux espèces (SAV-08) ;
- mods (NF-08) et audio (AST-06) ;
- empaquetage pour Steam et les stores.

## 10. Séances de conception

Chaque séance a lieu dans la conversation de conception, avant la phase concernée. Elle produit un document dans `docs/design/` et met à jour le PRD.

| Séance | Avant | Sujets | Questions du PRD (section 27) |
|---|---|---|---|
| C1 Monde | phase 1 | tenue le 8 novembre 2026 : eaux, côtes, zones humides, occupation du sol, saisons, relief, climat (`docs/design/C1-monde.md`) | 6, 7, 8 (closes) |
| C2 Peuples | phase 3 | tenue le 9 novembre 2026 : identités, appartenance, groupes nomades, fondation, établissements, colonies, territoires, échelle (`docs/design/C2-peuples.md`) | 3 (close) |
| C3 Gouvernements | phase 4, compléments avant la phase 8 | forme politique des villages, lien entre colonie et village mère, frontières politiques, dictature, anarchie, désignation, titres | 4, 5, 18 |
| C4 Saga | phase 5 | contrôle direct, carrières, format des événements | 9 |
| C5 Savoirs | phase 6 | domaines, contenu de l'arbre, ordre des chaînes | 13, 16 |
| C6 Économie | phase 7 | biens, formation des prix, banques, assurances | — |
| C7 Diffusion et religions | phase 9 | modèle de diffusion, religions, foi en Le Créateur | 2, 12 |
| C8 Batailles | phase 10 | système de batailles complet | 1 |
| C9 Écrans | phase 11 | perspective, moteur de génération, interactivité | 10 |

Les autres questions se traitent au fil de l'eau :
- question 11 (calibrage mobile) : mesures des phases 1 et 2 ;
- question 14 (auteur du pack) : phase 0 ;
- question 15 (titre du jeu) : quand tu veux.

## 11. Risques

| Risque | Parade |
|---|---|
| Périmètre très vaste : la version 1 représente des mois de travail, même avec Claude Code. | Jalons jouables, MVP tôt, priorités P0, P1 et P2 tenues ; effort recalibré après les phases 0 et 1. |
| Performances sur mobile, avec de grandes cartes et des dizaines de milliers d'individus. | Tableaux typés, niveaux de détail, bancs d'essai dès la phase 2, tailles réduites par défaut sur mobile. |
| Résultats différents d'un navigateur à l'autre. | Règles de déterminisme, tests d'empreinte, vérification sur au moins deux navigateurs. |
| Simulation instable : civilisations qui s'éteignent toutes ou explosent. | Paramètres en données, outils d'observation, tests de longue durée avec invariants. |
| Qualité des visuels procéduraux (portraits, architecture, écrans). | Primitives dessinées à la main et assemblées procéduralement ; planches de rendu revues avec toi. |
| Sauvegardes et mémoire qui grossissent au fil des siècles. | Archivage compact des morts, chronique compactée, limites mesurées dès le MVP. |
| Volume de contenu : savoirs, biens, événements. | Tout en données, validé automatiquement, écrit progressivement. |
| Dérive d'un gros code écrit par une IA. | `CLAUDE.md`, ADR, documents de conception, petites PR relues, tests. |
| Licence des assets dans un dépôt public. | Vérification de la licence avant tout versement ; crédits dès l'intégration. |

## 12. Démarrer

1. **Préparer le dépôt.** Places-y les fichiers suivants :
   - `docs/PRD.md` et `docs/PLAN.md` ;
   - `CLAUDE.md`, à la racine ;
   - tes notebooks, dans `prototypes/`.
   
   Vérifie la licence du pack avant de le verser dans `assets/source/`.
2. **Activer GitHub Pages.** Dans les réglages du dépôt, rubrique Pages, choisis « GitHub Actions » comme source.
3. **Lancer Claude Code** dans le dépôt, avec cette consigne :

```
Lis CLAUDE.md, docs/PRD.md et docs/PLAN.md. Nous démarrons la phase 0 du plan.
Si la CLI gh est configurée, crée le jalon « Phase 0 — Socle technique » et un
ticket par tâche (0.1 à 0.13) ; sinon, reporte la liste dans docs/BACKLOG.md.
Traite ensuite les tâches dans l'ordre, une branche et une PR par tâche, et
arrête-toi après chaque PR pour que je relise.
```

4. **Préparer la suite.** Les séances C1 et C2 sont faites : leurs documents vont dans `docs/design/`, leurs images dans `docs/design/C1/` et `docs/design/C2/`, et leurs scripts dans `prototypes/c1/` et `prototypes/c2/`. La prochaine séance, C3, précède la phase 4.
