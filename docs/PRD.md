# PRD — Jeu de simulation de mondes et de vies

Titre provisoire · version 0.2 · 8 novembre 2026

Historique : 0.1, première version ; 0.2, corrections de relecture (civilisations et cultures, domaines des savoirs, type et mode d'accès des gouvernements, sprites, dépôt public).

## 1. À propos de ce document

Ce document décrit ce que le jeu doit faire. Il ne dit ni comment le construire en détail, ni dans quel ordre : l'architecture et le séquencement feront l'objet du plan de développement.

Il consolide trois sources :
- le brief initial (`brief.md`) ;
- les prototypes Python (`testMap_filtre.ipynb`, `testArmoiries.ipynb`, `testVisages.ipynb`) ;
- les réponses au questionnaire du 8 novembre 2026.

Il devient la référence du projet ; le brief reste la trace de l'intention d'origine.

Chaque exigence porte un identifiant (un préfixe par domaine, par exemple `MON-03`) et une priorité :

| Priorité | Signification |
|---|---|
| P0 | Nécessaire au premier jalon jouable : un mode Créateur minimal. |
| P1 | Nécessaire à la version 1 complète : modes Saga et Libre, féodalité, économie, batailles. |
| P2 | Enrichissement ultérieur. |

Une exigence marquée « P0, puis P1 » doit exister sous une forme simple dès le premier jalon, puis être approfondie pour la version 1. Les propositions pas encore validées sont signalées « à valider » et reprises dans les questions ouvertes (section 28).

## 2. Vision

Un bac à sable de simulation en pixel art où un monde généré vit sa propre histoire. Des peuples y naissent, fondent des villages, inventent, créent des œuvres, fondent des religions, bâtissent des royaumes et se font la guerre.

Le joueur peut :
- façonner ce monde en Créateur, à la manière de WorldBox ;
- y naître et vivre une existence, puis celles de ses descendants, avec des choix à la BitLife et une profondeur dynastique et féodale à la Crusader Kings ;
- passer librement de l'un à l'autre.

| Pilier | Ce qu'il implique |
|---|---|
| Un monde qui vit sans le joueur | Tout ce qui arrive découle de la simulation et est consigné dans la chronique. On peut regarder des siècles d'histoire sans intervenir. |
| Chaque individu compte | Chacun a des gènes, une lignée, un métier et un patrimoine. Un soldat tombé manque à sa famille. N'importe qui peut être incarné. |
| Des systèmes qui s'entremêlent | Savoirs, cultures, langues, religions, économie, politique et guerre s'influencent mutuellement. |
| Tout est généré, tout est unique | Cartes, visages, armoiries, langues, religions, architecture et œuvres d'art sont générés, toujours en pixel art. |
| Une interface qui raconte | Chronique, arbres généalogiques, modes de carte, écrans de ville et de bataille, habillage qui évolue avec la civilisation. |

Le projet est personnel, mais il est mené avec l'exigence d'une sortie publique possible (Steam, stores mobiles). Licences, crédits et niveau de finition sont traités en conséquence.

## 3. Public, plateformes et contraintes

| Sujet | Décision |
|---|---|
| Plateformes | PC : navigateur, puis application empaquetée pour Steam. Mobile Android et iOS : application web installable, puis stores. PC et mobile sont pris en compte dès le départ. |
| Orientation | Paysage en priorité ; l'interface s'adapte au portrait. |
| Connexion | Jeu entièrement hors ligne. |
| Langue | Français d'abord ; tous les textes sont traduisibles dès le départ. |
| Multijoueur | Aucun. |
| Public | Adolescents et adultes. La violence et la mort sont présentes sans complaisance ; aucun contenu explicite. |
| Ton | Sérieux, avec une pointe d'humour. |

## 4. État des lieux

Les prototypes Python servent de références fonctionnelles et visuelles. Ils seront portés dans la technologie du jeu (section 25), en corrigeant au passage les défauts relevés.

### Génération de carte (`testMap_filtre.ipynb`)

Le pipeline enchaîne les étapes suivantes :
- **Relief** : bruit fractal OpenSimplex à trois échelles (continents, régions, détails).
- **Température** : latitude, altitude, bruit climatique.
- **Hydrologie** : remplissage des dépressions par priority flood, accumulation des écoulements, seuil de rivière proportionnel à la surface émergée, tracés lissés, largeur logarithmique selon le débit.
- **Humidité, continentalité et biomes** : classification climatique.

Le rendu dessine des tuiles de 4×4 px. Un débordement d'un pixel vers les cases plus basses donne le relief. Un shader ajoute la pente, une lumière venue du nord-est et une teinte thermique.

Le tout fonctionne et met une vingtaine de secondes pour une carte de 256×256 en Python pur.

Défauts relevés :
- `river_map_render = river_map` crée un alias et non une copie ;
- `create_biome_map` est appelé sans être défini ;
- les plages sont très larges (environ 13 % de la carte sur un essai en 256×256).

Un moteur de rendu 3D en perspective existe aussi, mais la vue 3D est abandonnée.

### Armoiries (`testArmoiries.ipynb`)

Le prototype contient :
- des champs (uni, bandes) et des bordures ;
- des meubles dessinés à la main en trois tons (lys, lion, macle, tour, croix, clefs) ;
- une palette héraldique à trois nuances par couleur ;
- la règle de contrariété des couleurs, dans la seconde version ;
- une ébauche de blasonnement en texte.

Plusieurs meubles sont déclarés mais vides : étoile, aigle, poisson, loup, dragon, triskell, rose, taureau, navire. La saisie des meubles par listes de coordonnées sera remplacée (HER-05).

### Portraits (`testVisages.ipynb`)

Ce sont des portraits de face de 32×48 px, paramétrés par :
- le sexe et l'âge ;
- la peau (6 teintes), les cheveux (8 couleurs) et les yeux (7 couleurs) ;
- les formes des yeux, de la mâchoire et du nez ;
- 10 coiffures et des barbes ;
- l'humeur, des accessoires (couronnes, diadème) et des cicatrices.

La dernière version plante : `rgb()` ajoute un canal alpha à des tuples déjà RGBA.

### Sprites

Le pack contient des corps de base vus de profil, en 5 teintes et 2 sexes, découpés en cases de 80×64 px. Le personnage fait environ 48 px de haut et dispose de 7 animations : repos (5 images), marche (8), course (8), saut (4), chute (4), attaque (6) et mort (10).

Les originaux sont disponibles en PNG transparents, avec quelques vêtements, sous licence libre avec attribution en cas d'usage commercial. Les copies jointes au projet ont subi une compression avec perte et ne doivent pas être utilisées. L'usage des originaux n'est pas acquis : il dépendra du moteur de génération des écrans de ville et de bataille.

## 5. Modes de jeu

Les trois modes partagent la même simulation. Une partie commence par la génération d'un monde, éventuellement suivie d'une préhistoire simulée en accéléré.

| ID | Exigence | Prio |
|---|---|---|
| MOD-01 | Une seule simulation et un seul format de monde servent aux trois modes. | P0 |
| MOD-02 | Mode Créateur : façonner le monde, faire apparaître des êtres, modifier n'importe quelle entité et observer (section 21). | P0, puis P1 |
| MOD-03 | Mode Saga : incarner un individu, puis un héritier à sa mort (section 20). | P1 |
| MOD-04 | Mode Libre : passer à tout moment des pouvoirs du Créateur à l'incarnation de n'importe quel individu. | P1 |
| MOD-05 | Préhistoire : avant une Saga, et sur demande en Créateur, le monde peut être simulé en accéléré sur une durée choisie (par exemple 100 à 1 000 ans), pour démarrer dans un monde déjà chargé d'histoire. | P1 |
| MOD-06 | Temps : pause, ralenti et accéléré dans tous les modes. Par défaut, un pas de temps vaut un mois et une année dure environ 10 s en vitesse normale. Une partie peut couvrir plusieurs siècles. | P0 |

## 6. Monde : géométrie, génération et biomes

Le monde est un cylindre : continu d'est en ouest, il est bordé de pôles au nord et au sud. Ce choix s'accorde avec le modèle de température par latitude du prototype.

Le monde infini a été écarté pour deux raisons :
- l'hydrologie a besoin de connaître tout le relief ;
- une simulation de civilisations doit rester bornée pour tenir les performances.

Le cylindre permet tout de même de faire le tour du monde.

| ID | Exigence | Prio |
|---|---|---|
| MON-01 | Monde cylindrique : le bord est rejoint le bord ouest sans couture, ni dans le relief, ni dans les rivières, ni dans les déplacements et les distances. Les bords nord et sud sont polaires. | P0 |
| MON-02 | Tailles prédéfinies au format 2:1 : Petit 512×256, Moyen 768×384, Grand 1024×512 (défaut sur PC), Immense 2048×1024 (PC, expérimental). Le défaut sur mobile reste à calibrer. | P0 |
| MON-03 | Génération déterministe : une graine et des paramètres (niveau de la mer, part des terres, température moyenne, humidité, densité du réseau hydrographique…) donnent toujours le même monde. | P0 |
| MON-04 | Pipeline repris du prototype et adapté au cylindre : relief par bruit fractal multi-échelle échantillonné sur un cylindre, température, hydrologie, humidité, continentalité, biomes. | P0 |
| MON-05 | L'altitude est découpée en 20 niveaux : 5 profondeurs d'eau, 2 niveaux de rivage, 5 de plaine, 3 de colline, 2 de basse montagne, moyenne montagne, haute montagne et sommet. | P0 |
| MON-06 | Les niveaux d'altitude ont des effets de jeu : coût de déplacement, fertilité, constructibilité et température dès le premier jalon ; défense, visibilité et navigabilité (selon le type de bateau) ensuite. | P0, puis P1 |
| MON-07 | Rivières navigables selon leur largeur et les savoirs maritimes, franchissables à gué ou par un pont (savoir « rue et pont »). Elles sont sources d'humidité, de pêche et d'irrigation. | P1 |
| MON-08 | Biomes naturels issus de la classification climatique du prototype (tableau ci-dessous). | P0 |
| MON-09 | Biomes anthropiques créés par l'activité humaine (tableau ci-dessous), qui peuvent retourner à l'état naturel. | P0, puis P1 |
| MON-10 | Chaque biome est défini par des données : fertilité, ressources, flore (types d'arbres et de buissons), faune, coût de déplacement, palette et tuiles. | P0 |

Biomes naturels, repris du prototype :

| Famille | Biomes |
|---|---|
| Eaux | océan profond, océan, océan côtier, rivière |
| Côtes | plage |
| Froids | neige, toundra, taïga, forêt froide, steppe froide |
| Montagne | alpin, montagne, haute montagne |
| Tempérés | prairie, steppe, forêt tempérée, forêt pluviale tempérée |
| Arides | désert |
| Chauds et tropicaux | savane, prairie tropicale, forêt tropicale, forêt pluviale |

Biomes anthropiques, liste proposée à valider :

| Biome | Origine | Retour à l'état naturel |
|---|---|---|
| Bocage | champs et pâtures bordés de haies | friche, puis forêt |
| Grandes cultures | champs ouverts de culture intensive | friche |
| Pâturages | élevage | prairie ou friche |
| Vergers et vignes | cultures pérennes | friche |
| Coupe | forêt abattue | forêt, en quelques décennies |
| Friche | terre cultivée abandonnée | biome naturel d'origine |
| Terre brûlée | incendie, tactique de la terre brûlée | biome d'origine, lentement |
| Terre ravagée | champ de bataille | biome d'origine |
| Carrière et mine | extraction | friche, lentement |
| Zone bâtie | village, ville | ruines, puis friche |

Routes et ponts forment une couche à part, superposée aux biomes.

## 7. Ressources, faune et évolution du terrain

| ID | Exigence | Prio |
|---|---|---|
| RES-01 | Minerais : pierre, cuivre, étain, fer, charbon, or, argent, sel et gemmes, placés selon l'altitude et le biome. | P0 |
| RES-02 | Gisements épuisables, d'exploitation de plus en plus coûteuse. | P1 |
| RES-03 | Le bois et la cueillette sont de vraies ressources, qui se régénèrent. | P0 |
| RES-04 | Pêche en mer et en rivière. | P0 |
| FAU-01 | La faune apparaît selon le biome et ses populations varient ; le gibier est chassé. | P0 |
| FAU-02 | Animaux dangereux (loups, ours…) et domestication débloquée par les savoirs (cheval pour la cavalerie, bétail). | P1 |
| TER-01 | Le terrain évolue sous l'action humaine : déforestation, défrichement, champs, routes et ponts, extension des villes case par case, carrières et mines. | P0 |
| TER-02 | Les batailles ravagent les terres ; la terre brûlée est possible. | P1 |
| TER-03 | Les terres délaissées retournent à l'état naturel : friches, forêts qui repoussent, ruines. | P1 |
| TER-04 | Érosion lente, optionnelle. | P2 |
| TER-05 | Marées : les rivages se découvrent et se recouvrent, avec des effets possibles (pêche à pied, gué temporaire). | P2 |

## 8. Rendu, vues et direction artistique

La carte reste en 2D vue de dessus, dans le style du prototype. Il n'y a pas de vue 3D. Des écrans de visualisation en pixel art montrent les paysages, les villes et les batailles.

| ID | Exigence | Prio |
|---|---|---|
| REN-01 | Vue principale en 2D de dessus, tuiles de 4 px, avec le débordement de relief et le shader du prototype. Zoom continu ; défilement sans fin d'est en ouest. | P0 |
| REN-02 | Rendu par blocs : seules les zones modifiées sont redessinées, ce qui permet le terrain évolutif. | P0 |
| REN-03 | Le détail affiché dépend du zoom. Vue lointaine : frontières, couleurs politiques, icônes de villes, bannières d'armées. Vue intermédiaire : bâtiments, routes, champs, formations militaires. Vue rapprochée : habitants animés, bétail, chantiers. | P0, puis P1 |
| REN-04 | Mini-sprites à l'échelle de la carte, de l'ordre de 6 à 10 px de haut. Ils sont générés à partir de l'individu : teinte, vêtements selon la culture, le rang et le métier, équipement. | P0, puis P1 |
| REN-05 | Les sprites de profil originaux (environ 48 px) peuvent servir aux écrans de visualisation et à la fiche du personnage, avec superposition de vêtements, de coiffures et d'équipements. Leur usage dépendra du moteur de génération de ces écrans ; des sprites générés peuvent les remplacer. | P1 |
| REN-06 | Écrans de visualisation générés en pixel art. Paysage : selon le biome, le relief, le climat, la saison et l'heure. Ville : architecture selon la culture et les savoirs, taille et richesse. Bataille : armées, terrain, déroulé. | P1 |
| REN-07 | Portraits de face de 32×48 px, dérivés du prototype et pilotés par : les gènes (teinte, couleurs, formes), l'âge (rides, cheveux gris, calvitie), le rang (couronne ou coiffe selon le titre), la culture et le métier (vêtements), l'état (cicatrices, maladies) et l'humeur. | P0, puis P1 |
| REN-08 | Tout est en pixel art. Une même vue n'affiche qu'une seule densité de pixels. Afficher les sprites de 48 px plus petits que les pixels de la carte produirait des « mixels » et casserait la cohérence, d'où les mini-sprites dédiés. | P0 |
| REN-09 | Palettes organisées par rôles (contour, ombre, base, lumière) et recolorées à l'exécution : un même motif sert à toutes les teintes de peau, couleurs héraldiques et matériaux. | P0 |

## 9. Individus, génétique, familles, maisons et ordres

Le modèle est hybride : tout le monde existe vraiment, mais seuls les notables ont une vie intérieure détaillée. C'est ce qui permet de simuler des dizaines de milliers d'individus, y compris sur mobile.

| ID | Exigence | Prio |
|---|---|---|
| IND-01 | Tous les individus ont une identité, des gènes, une généalogie, un métier, un lieu de vie et un patrimoine. | P0 |
| IND-02 | Les notables ont en plus des relations, des opinions, des ambitions, une mémoire et des intrigues. Sont notables les nobles, dirigeants, clercs importants, spécialistes, artistes, riches et proches du joueur. La notabilité est dynamique : on peut le devenir et cesser de l'être. | P1 |
| IND-03 | Capacité visée : de 10 000 à 50 000 individus vivants sur PC, moins sur mobile (à calibrer). Les morts restent consultables dans la généalogie et la chronique. | P0 |
| IND-04 | Cycle de vie : naissance, enfance, éducation, âge adulte, couple, enfants, vieillesse et mort (naturelle, maladie, famine, guerre, accident, meurtre, exécution). | P0 |
| IND-05 | Gènes physiques : teinte de peau, couleur des cheveux et des yeux, forme du visage, taille, force de base, rapidité de base, vision. Gènes mentaux : intelligence de base, ambition de base. | P0 |
| IND-06 | Hérédité mendélienne (allèles dominants et récessifs) pour les traits discrets, polygénique (moyenne des parents et variation) pour les traits continus, avec de rares mutations. | P0 |
| IND-07 | Traits acquis distincts des gènes : compétences par domaine, éducation, santé, cicatrices, traits de caractère, réputation. | P0, puis P1 |
| IND-08 | Noms : prénom et nom de famille selon les règles de la culture (hérité d'un parent, obtenu, mélange des deux, ou inexistant), formés à partir de la langue. | P0 |
| IND-09 | Couple et mariage selon les règles de la culture. | P1 |
| FAM-01 | Tout individu a une lignée. Les familles notables forment une maison, le « clan » du brief : un nom, des armoiries, un chef, des branches cadettes et un prestige. | P0, puis P1 |
| FAM-02 | Ordres religieux rattachés à une religion, avec un chef, des armoiries et leurs propres règles d'entrée (vœux, recrutement, mérite) plutôt que la naissance. | P1 |
| FAM-03 | Ordres militaires et de chevalerie sur le même modèle. | P2 |

## 10. Espèces

| ID | Exigence | Prio |
|---|---|---|
| ESP-01 | Version initiale : humains seuls, en trois sous-espèces (nordiques, des plaines, des sables). | P0 |
| ESP-02 | Les sous-espèces humaines diffèrent par l'adaptation (froid, chaleur, endurance, biomes de prédilection) et l'apparence, pas par les capacités mentales. | P0 |
| ESP-03 | Les espèces sont décrites par des données (longévité, fertilité, maturité, caractéristiques, biomes, apparence, affinités), pour pouvoir en ajouter sans modifier le moteur. | P0 |
| ESP-04 | Métissage entre sous-espèces d'une même espèce. | P0 |
| ESP-05 | Nains (des collines, des montagnes), orques (des forêts, des collines) et elfes (des bois, hauts elfes, elfes noirs), avec de vraies différences de jeu ; hybrides demi-elfes et demi-orques. | P2 |
| ESP-06 | Monstres (dragons…). | P2 |

## 11. Civilisations et cultures

Civilisation et culture sont deux notions distinctes et indépendantes. Plusieurs cultures peuvent coexister au sein d'une civilisation, et une même culture peut exister dans plusieurs civilisations.

| Entité | Rôle |
|---|---|
| Civilisation | Peuple issu d'une fondation, qui porte la maîtrise des savoirs. Elle peut compter plusieurs cultures. |
| Culture | Porte les coutumes et parle une langue. Elle peut être présente dans plusieurs civilisations. |
| Religion | Indépendante de la culture comme de la civilisation ; elle se diffuse à sa façon. |
| Gouvernement | L'entité politique. |

Un individu appartient à une civilisation et à une culture, parle une ou plusieurs langues, suit une religion et est sujet d'un gouvernement.

| ID | Exigence | Prio |
|---|---|---|
| CIV-01 | Fondation : trois individus ou plus d'une même espèce, sans civilisation, sur un territoire assez vaste et sans village, fondent une civilisation. Ses caractéristiques initiales dépendent de l'espèce et du biome. Elle naît avec un village, une langue et une culture. | P0 |
| CIV-02 | Une civilisation peut se scinder. | P1 |
| CIV-03 | Relation libre entre civilisations et cultures : plusieurs cultures coexistent dans une civilisation, et une culture peut être présente dans plusieurs civilisations. Le modèle de données le permet dès le premier jalon. | P0 |
| CIV-04 | Un individu ou un village appartient à une civilisation par la naissance, la fondation d'une colonie, la conquête ou l'assimilation. Les règles restent à concevoir. | P0, puis P1 |
| CUL-01 | Une culture définit : règles de nommage, style architectural, style vestimentaire, valeurs (guerrière, marchande, pieuse, savante, artistique…), lois de succession et d'héritage, place des genres, règles matrimoniales et doctrines militaires privilégiées. | P0, puis P1 |
| CUL-02 | Une culture se scinde avec la distance, l'isolement et le temps ; fusions et assimilations sont possibles. | P1 |
| CUL-03 | La diffusion des cultures, des langues et des religions dépend de leur niveau (prestige, raffinement, savoirs) et de celui des individus en contact (éducation, charisme, rang, intensité et durée des échanges). Le modèle reste à concevoir. | P1 |

## 12. Langues

| ID | Exigence | Prio |
|---|---|---|
| LAN-01 | Chaque langue a une phonologie générée (inventaire de sons, structure des syllabes, règles d'enchaînement) qui donne une identité sonore cohérente à tous ses noms. | P0 |
| LAN-02 | Un lexique d'environ 200 racines (rivière, montagne, rouge, roi, loup…) sert à nommer les personnes, les lieux, les maisons, les religions et les œuvres. L'interface peut afficher le sens d'un nom, par exemple « la baie du loup ». | P1 |
| LAN-03 | Quand une culture se scinde, sa langue diverge par des mutations phonétiques régulières : les langues sœurs restent reconnaissables et forment des familles. | P1 |
| LAN-04 | Emprunts entre langues en contact. | P2 |

Il n'y a ni grammaire complète, ni traduction de phrases.

## 13. Religions

| ID | Exigence | Prio |
|---|---|---|
| REL-01 | Une religion naît dans une culture ou un clan. Elle est fondée par un individu (prophète, réformateur), ce qui en fait une voie possible en mode Saga. | P1 |
| REL-02 | Religions monothéistes ou polythéistes. Les divinités peuvent être des animaux, des éléments, ou des lieux réels du monde (telle rivière, telle mer, tel océan, telle montagne), qui deviennent alors des lieux saints. | P1 |
| REL-03 | Contenu généré : nom, divinités, rites, lieux saints, symbole, clergé, et dogmes ayant des effets sur les lois et les comportements (alimentation, mariage, guerre, commerce, savoirs, arts). | P1 |
| REL-04 | Une religion monothéiste vénère Le Créateur, c'est-à-dire le joueur. Ses interventions en mode Créateur ou Libre peuvent être lues comme des miracles ou des châtiments et faire varier la ferveur. Son mode d'apparition reste à valider. | P1 |
| REL-05 | Diffusion, conversion, syncrétisme, schismes et hérésies, selon le modèle de diffusion (CUL-03). | P1 |
| REL-06 | La hiérarchie du clergé suit la nomenclature théocratique (paroisse, diocèse, archidiocèse, église, foi) ; les ordres religieux s'y rattachent (FAM-02). | P1 |

## 14. Savoirs et technologies

| ID | Exigence | Prio |
|---|---|---|
| SAV-01 | Les savoirs sont répartis en domaines distincts : politique, économie, art, artisanat et industrie, urbanisme, militaire, langage, marine (liste ouverte). Ils forment un graphe avec des prérequis croisés entre domaines : l'épée exige la forge, la monnaie l'écriture… Le contenu initial reprend les chaînes du brief, complétées (tableau ci-dessous). | P0, puis P1 |
| SAV-02 | Une invention exige un spécialiste du domaine assez intelligent, une maîtrise suffisante des savoirs prérequis et du temps. Ce temps diminue avec l'intelligence, la maîtrise, le nombre de spécialistes et le contexte (incitations du gouvernement, bibliothèques, académies). | P0, puis P1 |
| SAV-03 | Un savoir peut aussi être appris d'une civilisation voisine qui le maîtrise parfaitement ; il est alors acquis au niveau de base. | P1 |
| SAV-04 | La maîtrise est portée par la civilisation (de 0 à 100 %), doublée de compétences individuelles. Elle progresse avec la pratique et régresse sans elle. Elle peut se perdre si plus personne ne la pratique : c'est l'âge sombre. | P1 |
| SAV-05 | Les savoirs débloquent : bâtiments, techniques architecturales (qui pilotent l'apparence des bâtiments), biens manufacturables, unités et équipements, doctrines militaires, régimes et institutions politiques, matériaux d'écriture (qui pilotent l'habillage de l'interface). | P0, puis P1 |
| SAV-06 | Les régimes politiques se débloquent par les savoirs : la dictature d'abord, puis les autres régimes. Les institutions suivent la chaîne débat, conseil, parlement. | P1 |
| SAV-07 | Le plafond technologique se situe vers le XIXe siècle (vapeur, carabine, bourse). | P1 |
| SAV-08 | Un tronc commun à toutes les espèces, avec des branches propres à une espèce ou à une culture. | P2 |

Chaînes initiales, reprises du brief et complétées :

| Domaine | Chaînes |
|---|---|
| Politique | dictature → tous les régimes ; débat → conseil → parlement |
| Économie | troc → monnaie → commerce → entrepreneuriat → bourse → spéculation (chaîne placée en politique dans le brief) ; banque et assurance à insérer |
| Art | pictogramme → enluminure → peinture ; chant → théâtre → musique ; styles architecturaux à définir |
| Artisanat et industrie | culture vivrière → canaux → moulin → culture intensive ; coupe du bois → menuiserie → charpenterie ; minage → forge → sidérurgie |
| Urbanisme | chemin → rue et pont → avenue et route ; mur → muraille → tour → citadelle ; hutte → cabane → maison → demeure → immeuble ; donjon → palais → ministère, académie, quartier général, beaux-arts ; techniques de construction à définir (charpente, maçonnerie, arc, voûte, coupole…) |
| Militaire | bâton → tomahawk → marteau → épée → sabre ; fronde → arc → arbalète ; bombe → canon → fusée → mousquet → carabine ; armure de cuir → armure de fer → armure d'acier ; organisation → tactique → stratégie |
| Langage | grammaire → poésie ; écriture → calligraphie |
| Marine | barque → barge → voilier → galion → bateau à vapeur ; ponton → quai → phare → port |

L'architecture n'est pas un domaine à part : ses techniques de construction relèvent de l'urbanisme et ses styles de l'art (proposition à valider). Les deux pilotent ensemble le rendu procédural des bâtiments (ARC-01).

## 15. Arts et architecture

| ID | Exigence | Prio |
|---|---|---|
| ART-01 | Les œuvres sont des objets du monde : titre (dans la langue de l'auteur), auteur, date, lieu, style, qualité, propriétaire, prestige et histoire (commandes, ventes, vols, destructions). | P1 |
| ART-02 | Visuels procéduraux en pixel art : tableaux (paysages, portraits, scènes), enluminures, calligraphies. Le style dépend de la culture, de l'époque et du talent. | P1 |
| ART-03 | Arts du spectacle et de la langue (chant, théâtre, musique, poésie) : titres et thèmes générés, représentations, prestige. | P1 |
| ART-04 | Les œuvres apportent du prestige à leur auteur, à leur mécène, à leur ville et à leur gouvernement ; elles nourrissent l'influence culturelle (CUL-03). | P1 |
| ARC-01 | L'apparence des bâtiments résulte de la culture (style), des savoirs (techniques et matériaux), de la fonction et de la richesse. Elle est visible sur la carte et dans les écrans de ville et de bataille. | P0, puis P1 |
| ARC-02 | Les bâtiments sont assemblés à partir d'éléments (fondations, murs, ouvertures, toitures, ornements) plutôt que dessinés un par un. | P1 |

## 16. Héraldique

| ID | Exigence | Prio |
|---|---|---|
| HER-01 | Armoiries générées pour les gouvernements, les maisons et les ordres ; les villes en reçoivent à partir d'une certaine importance (proposition). | P0, puis P1 |
| HER-02 | Règles héraldiques : métaux et couleurs (les « émaux » du prototype), règle de contrariété (jamais métal sur métal ni couleur sur couleur), champs et partitions, bordures, meubles et leurs dispositions. | P0 |
| HER-03 | Transmission : écartelé lors des unions, brisures pour les cadets. | P1 |
| HER-04 | Blasonnement automatique en français, par exemple « D'azur à trois fleurs de lys d'or ». | P1 |
| HER-05 | Meubles refaits avec une méthode de saisie plus pratique que les listes de coordonnées : des masques indexés par rôle de teinte, éditables dans un logiciel de pixel art ou sous forme de grille de texte. La collection est complétée (étoile, aigle, poisson, loup, dragon, triskell, rose, taureau, navire…). | P0, puis P1 |
| HER-06 | Le joueur peut modifier toutes les armoiries en Créateur, et celles de sa maison en Saga. | P1 |
| HER-07 | Styles propres aux espèces, aux cultures et aux religions (formes d'écu, motifs, conventions). | P2 |

## 17. Politique, gouvernements et féodalité

Chaque village a son administration. Un gouvernement est toujours rattaché à une ville, sa capitale. Dès qu'il gère plus d'un village, il forme de fait un ensemble plus vaste, dont le niveau dépend de sa composition. Cela peut se produire par fondation de colonie, conquête, vassalisation ou achat.

| ID | Exigence | Prio |
|---|---|---|
| POL-01 | Chaque village a son administration ; un gouvernement est rattaché à une ville ; les ensembles se forment par fondation de colonie, conquête, vassalisation ou achat. Les gouvernements peuvent être vassaux les uns des autres. | P0 |
| POL-02 | Chaque gouvernement a deux attributs indépendants : un type (monarchie, république, oligarchie, dictature, théocratie, anarchie) et un mode d'accès au pouvoir (POL-03). Le type ne fixe pas le mode, mais en favorise certains (POL-05 à POL-07) : une monarchie élective, par exemple, est une monarchie dont le mode d'accès est démocratique ou aristocratique. | P0, puis P1 |
| POL-03 | Modes d'accès au pouvoir : héréditaire (enfant du dirigeant), aristocratique (choix parmi les membres d'un clan), démocratique (élection par tous les sujets), ploutocratique (le plus riche des sujets) et aléatoire. La prise du pouvoir par la force (coup d'État, révolution) n'est pas un mode d'accès : c'est un événement, qui peut changer le dirigeant, le type ou le mode. La désignation du successeur par le dirigeant reste une proposition de mode supplémentaire, à valider. | P0, puis P1 |
| POL-04 | Niveaux 1 à 5 selon les tableaux ci-dessous. Les noms et titres sont modifiables pour chaque civilisation, traduisibles, et déclinés au féminin (baronne, comtesse, reine…). | P0, puis P1 |
| POL-05 | Monarchie : un souverain unique et un conseil formé de membres de son clan, ou des clans de ses vassaux s'ils sont aussi monarchiques. Elle favorise l'accès héréditaire et l'adoption de sa loi par ses vassaux. | P0 |
| POL-06 | République : de 1 à 2 × (nombre de villages) dirigeants élus pour une durée allant d'un an à la vie. Elle favorise l'accès démocratique ou aristocratique et l'adoption de sa doctrine militaire par ses vassaux. | P1 |
| POL-07 | Oligarchie : le pouvoir appartient aux membres d'un ou plusieurs clans. Elle favorise l'accès héréditaire ou aristocratique. | P1 |
| POL-08 | Dictature : à concevoir. Anarchie : pas de chef, décisions collectives ; le reste est à concevoir. | P1 |
| POL-09 | Vassalité à la Crusader Kings : obligations (impôts, levées), opinions, revendications, mariages d'alliance, factions et révoltes. | P1 |
| POL-10 | Complots et assassinats. | P2 |
| POL-11 | Lois de succession, dont la place des genres (agnatique, cognatique…) comme paramètre culturel. Héritage des biens selon les lois de la culture et de la civilisation et selon le testament (SAG-08). | P1 |
| POL-12 | Fiscalité : impôt plancher, impôt sur la production, sur les décès et les successions… | P1 |
| POL-13 | Politiques publiques : favoriser la recherche, l'art, l'armée, le commerce et l'entrepreneuriat par des incitations financières ou des investissements. | P1 |
| POL-14 | Institutions débloquées par les savoirs : débat, conseil, parlement ; ministère, académie, quartier général, beaux-arts. | P1 |

Niveaux de gouvernement :

| Niveau | Composition (capitale et vassaux) |
|---|---|
| 1 | La capitale seule. |
| 2 | La capitale et au moins un gouvernement de niveau 1. |
| 3 | La capitale et au moins un gouvernement de niveau 2, ou au moins quatre de niveau 1. |
| 4 | La capitale et au moins un gouvernement de niveau 3, ou au moins quatre de niveau 2. |
| 5 | La capitale et au moins deux gouvernements de niveau 4. |

Nomenclature : chaque case donne l'entité, puis le titre de son chef. Elle dépend du type et du niveau, pas du mode d'accès. L'astérisque signale une proposition à valider.

| Niveau | Monarchie | République | Oligarchie | Dictature | Anarchie | Théocratie |
|---|---|---|---|---|---|---|
| 1 | Baronnie, baron | Commune, maire | Ville, podestat | Commune, maire | Ville, sans chef | Paroisse, seigneur |
| 2 | Comté, comte | Territoire, intendant | Domaine, maître | Territoire, intendant | Zone, sans chef | Diocèse, évêque |
| 3 | Duché, duc | Province, préfet | Province, préfet | Province, préfet | Zone, sans chef | Archidiocèse, archevêque |
| 4 | Royaume, roi | République, consul | État, doge* | Tyrannie*, tyran | Association, sans chef | Église, cardinal |
| 5 | Empire, empereur | Fédération, président* | Empire, empereur | Empire, empereur | Conglomérat, sans chef | Foi, pontife |

## 18. Économie

| ID | Exigence | Prio |
|---|---|---|
| ECO-01 | Biens multiples, décrits par des données : matières premières (nourritures variées, bois, pierre, minerais, fibres, cuirs…), produits intermédiaires (métaux, tissus, planches, outils), objets manufacturés issus des savoirs découverts ou inventés (armes, armures, navires, instruments, livres, horloges…) et biens de luxe. | P0, puis P1 |
| ECO-02 | Production par les individus selon leur métier, dans des ateliers puis des manufactures, avec des chaînes de production. | P0, puis P1 |
| ECO-03 | Chaque ville a un marché, des stocks et des prix qui résultent de l'offre et de la demande. | P1 |
| ECO-04 | Commerce entre villes reliées par route, rivière ou mer, par des marchands, des caravanes et des flottes. Troc avant l'invention de la monnaie. | P1 |
| ECO-05 | Monnaie, crédit et banques : dépôts, prêts, intérêts, faillites. | P1 |
| ECO-06 | Assurances : cargaisons, récoltes, biens. | P1 |
| ECO-07 | Entreprises fondées par des individus : capital, employés, production, profits. Viennent ensuite les parts, la bourse et la spéculation, selon les savoirs. | P1 |
| ECO-08 | Immobilier : terres et bâtiments ont une valeur, s'achètent, se vendent et se louent ; hypothèques (proposition). | P1 |
| ECO-09 | Fortunes individuelles (liquidités et patrimoine), indispensables à la ploutocratie et à l'héritage. | P0 |
| ECO-10 | Finances publiques : recettes fiscales (POL-12) et dépenses (armée, bâtiments, incitations). | P1 |
| ECO-11 | Subsistance : la nourriture disponible, les disettes et les famines influencent la démographie. | P0 |

## 19. Armée, guerre et diplomatie

Les batailles sont tactiques, visibles et commandables. Le système détaillé (moral, effectifs, mouvements, doctrines) fera l'objet d'une séance de conception dédiée ; les exigences ci-dessous en fixent le cadre.

| ID | Exigence | Prio |
|---|---|---|
| MIL-01 | Organisation terrestre (tableau ci-dessous). | P0, puis P1 |
| MIL-02 | Organisation navale (tableau ci-dessous). | P1 |
| MIL-03 | Chaque soldat est un individu, recruté dans la population (levées, professionnels). Sa mort pèse sur sa famille et sur la démographie. | P0 |
| MIL-04 | Couche stratégique : déplacement des armées sur la carte, moral, effectifs, fatigue, effets du terrain et de l'altitude ; ravitaillement (proposition). | P0, puis P1 |
| MIL-05 | Doctrines militaires selon la culture et les savoirs (organisation, tactique, stratégie, armes disponibles). | P1 |
| MIL-06 | Batailles tactiques visibles, dont la forme dépend de l'échelle (tableau ci-dessous). Moral, effectifs et terrain y jouent pleinement. | P1 |
| MIL-07 | En mode Saga, le personnage commande au niveau de son grade : escouade, compagnie, bataillon ou armée. Les autres échelons suivent l'IA et la doctrine. | P1 |
| MIL-08 | Les batailles non observées sont résolues automatiquement selon les mêmes règles. | P0, puis P1 |
| MIL-09 | Chaque bataille ravage le terrain (TER-02) et figure dans la chronique avec un rapport. | P1 |
| MIL-10 | Batailles navales. | P2 |
| DIP-01 | Guerre : déclarations et buts de guerre, occupation, paix. | P0, puis P1 |
| DIP-02 | Diplomatie complète : traités (paix, non-agression, commerce, passage, tribut), alliances et coalitions, vassalisation forcée ou négociée, achat et échange de territoires, mariages d'alliance, ambassades. | P1 |

Organisation terrestre :

| Unité | Composition | Commandant | Effectif | Armes |
|---|---|---|---|---|
| Escouade | 5 à 10 hommes | caporal | 5 à 10 | une seule : infanterie, cavalerie ou artillerie |
| Compagnie | 5 escouades | capitaine | 25 à 50 | une seule |
| Bataillon | 2 à 5 compagnies | commandant | 100 à 250 | une seule, plus éventuellement une compagnie de soutien |
| Armée | un ou plusieurs bataillons et compagnies | général | plus de 250 | toutes |
| Armée nationale | toutes les armées d'un gouvernement | maréchal | plus de 500 | toutes |

Organisation navale :

| Unité | Composition | Commandant |
|---|---|---|
| Vaisseau | un bateau | enseigne |
| Flottille | un galion et au moins deux bateaux | capitaine |
| Flotte | une ou plusieurs flottilles | amiral |

Formes de bataille selon l'échelle :

| Échelle | Forme |
|---|---|
| Escouades et compagnies | escarmouche individuelle |
| Bataillons | bataille rangée avec mouvement des compagnies (lignes de bataille) |
| Armées | bataille rangée avec mouvement des bataillons et des compagnies |

## 20. Mode Saga

| ID | Exigence | Prio |
|---|---|---|
| SAG-01 | Naissance au choix (espèce, région, rang social, famille existante) ou tirée au sort, dans un monde pré-simulé (MOD-05). | P1 |
| SAG-02 | Contrôle mixte : le personnage est visible sur la carte, voyage par clic et agit par menus et cartes d'événements. Un contrôle direct est possible (déplacement, interaction, combat) ; son périmètre reste à préciser. | P1 |
| SAG-03 | Le temps s'écoule et se met en pause à chaque choix ; la vitesse est réglable. | P1 |
| SAG-04 | Interface de base commune à toutes les carrières : fiche (portrait, poupée en pied, traits, compétences, santé), famille et maison, relations, patrimoine, lieu et déplacements, actions, journal de vie. | P1 |
| SAG-05 | Des onglets s'ajoutent selon les rôles du personnage : gouverner (lois, conseil, vassaux, impôts, diplomatie), mener une religion ou un ordre, gérer une entreprise, faire de la recherche, gérer de l'immobilier, commander une unité, créer des œuvres. | P1 |
| SAG-06 | Parcours de vie : paysan, artisan, marchand, soldat, clerc, savant inventeur, artiste, entrepreneur, banquier, seigneur, dirigeant… On peut en changer au cours de la vie. | P1 |
| SAG-07 | À la mort du personnage, le joueur choisit qui incarner parmi ses enfants ou ses proches. Titres, charges et biens se transmettent selon les lois en vigueur (celles du gouvernement du lieu de décès, de la culture et de la civilisation) et selon le testament. | P1 |
| SAG-08 | Le personnage peut rédiger et modifier un testament, dans les limites des lois. | P1 |
| SAG-09 | Objectifs : prestige dynastique et succès. Il n'y a pas de condition de victoire ; la partie continue tant qu'il reste un proche à incarner. | P1 |

## 21. Modes Créateur et Libre

| ID | Exigence | Prio |
|---|---|---|
| CRE-01 | Génération : graine et paramètres (MON-03), aperçu, régénération. | P0 |
| CRE-02 | Pinceaux de terrain : relever, abaisser, aplanir, creuser des mers et des lacs, tracer des rivières, peindre des biomes, placer des ressources. | P0, puis P1 |
| CRE-03 | Faire apparaître des individus (espèce, sous-espèce, nombre) et des animaux. | P0 |
| CRE-04 | Modifier arbitrairement toute entité : noms, caractéristiques des gouvernements et traits des individus d'abord, puis armoiries, cultures et religions. | P0, puis P1 |
| CRE-05 | Inspecter toute entité et consulter la chronique. | P0 |
| CRE-06 | Les interventions du Créateur peuvent être perçues par les religions, en particulier la foi en Le Créateur (REL-04). | P1 |
| CRE-07 | Catastrophes : séismes, épidémies, sécheresses, incendies, inondations… | P2 |
| LIB-01 | Mode Libre : basculer à tout moment entre les pouvoirs du Créateur et l'incarnation de n'importe quel individu, sans perdre la partie. | P1 |

## 22. Événements, choix et chronique

| ID | Exigence | Prio |
|---|---|---|
| EVT-01 | Système d'événements piloté par les données : déclencheurs, conditions, choix, effets, textes traduisibles. | P1 |
| EVT-02 | Contenu écrit à la main dans un format simple : une première base est fournie, puis enrichie par l'auteur du jeu. | P1 |
| CHR-01 | Tout fait notable est consigné dans la chronique avec sa date, son lieu et ses acteurs : fondations, changements de gouvernement, inventions, œuvres, batailles, guerres, traités, naissances, mariages et morts de notables, conversions, catastrophes… | P0 |
| CHR-02 | La chronique se consulte par civilisation, ville, gouvernement, maison, religion et individu, avec des filtres et une frise chronologique. | P0, puis P1 |
| CHR-03 | Statistiques historiques : population, richesse, frontières et puissance militaire au fil du temps. | P1 |

## 23. Interface

| ID | Exigence | Prio |
|---|---|---|
| IHM-01 | Modes de carte : relief, biomes, politique, culture, religion, langue, économie, ressources, densité de population. | P0, puis P1 |
| IHM-02 | Panneau d'inspection pour toute entité : individu, ville, gouvernement, maison, culture, langue, religion, armée, œuvre. | P0 |
| IHM-03 | Arbre généalogique navigable. | P1 |
| IHM-04 | Graphiques d'évolution. | P1 |
| IHM-05 | Habillage évolutif selon les matériaux d'écriture de la civilisation : écorce, parchemin, papier médiéval, papier écru, puis papier imprimé (proposition). En Saga, c'est celui de la civilisation du personnage ; en Créateur, celui de la civilisation observée. | P1 |
| IHM-06 | Interface sobre avec des touches médiévales, lisible sur téléphone. | P0 |
| IHM-07 | Souris et clavier sur PC ; tactile sur mobile (pincer pour zoomer, appui long pour inspecter). | P0 |
| IHM-08 | Écran de crédits mentionnant notamment l'auteur du pack de sprites. | P1 |

## 24. Exigences non fonctionnelles

| ID | Exigence | Prio |
|---|---|---|
| NF-01 | Carte fluide : 60 images par seconde sur PC, 30 sur un téléphone de milieu de gamme. | P0 |
| NF-02 | La simulation tourne dans un fil séparé et ne bloque jamais l'interface. | P0 |
| NF-03 | Générer un monde Grand (1024×512) prend moins de 10 s sur PC (cible à affiner). | P0 |
| NF-04 | Jeu entièrement hors ligne. | P0 |
| NF-05 | Sauvegardes locales, automatiques et manuelles ; export et import d'un fichier pour passer d'un appareil à l'autre ; format versionné, avec migration des anciennes sauvegardes. | P0, puis P1 |
| NF-06 | Aucun texte en dur : tout passe par le système de traduction. | P0 |
| NF-07 | Le contenu (espèces, biomes, savoirs, biens, cultures, événements, titres…) est décrit par des données modifiables sans toucher au code. | P0 |
| NF-08 | Ouverture aux moddeurs. | P2 |
| NF-09 | Déterminisme : une même graine et les mêmes paramètres donnent le même monde. Une simulation relancée depuis une sauvegarde se déroule à l'identique, ce qui facilite le débogage. | P0 |
| NF-10 | Un monde peut tourner pendant des siècles sans dégradation : mémoire bornée, archivage des morts et de l'historique. | P1 |
| NF-11 | Tests automatisés sur le cœur de la simulation. | P0 |

## 25. Choix techniques et organisation

Le jeu est développé pour le web, en TypeScript :

| Brique | Technologie |
|---|---|
| Rendu de la carte | PixiJS (WebGL) |
| Simulation | Web Worker |
| Interface | HTML et CSS |

Le jeu s'installe comme une application web sur PC et sur mobile. Il sera ensuite empaqueté pour Steam et les stores. Le choix des outils d'empaquetage se fera à ce moment-là : Tauri ou Electron sur PC, Capacitor sur mobile.

Le code vit dans un dépôt git public sur GitHub. Sans fichier de licence, il reste sous droits réservés, ce qui préserve une sortie commerciale. Les assets tiers n'y sont versés que si leur licence autorise la redistribution. Les versions de test sont publiées automatiquement sur GitHub Pages. Claude écrit l'essentiel du code avec Claude Code, directement dans le dépôt ; l'auteur du jeu dirige, relit et teste. La conversation de conception sert au design, au plan et à des prototypes jouables publiés en lien. Les prototypes Python restent dans le dépôt comme références. L'architecture détaillée est décrite dans le plan de développement (`docs/PLAN.md`).

## 26. Assets, licences et crédits

| ID | Exigence | Prio |
|---|---|---|
| AST-01 | Si le pack de sprites est utilisé, ce sont les originaux (PNG transparents, avec vêtements), pas les copies dégradées. Le dépôt étant public, ils n'y sont versés que si la licence autorise leur redistribution. | P0 |
| AST-02 | Licence libre avec attribution en cas d'usage commercial. Le nom de l'auteur et le lien sont consignés dans un fichier de crédits dès l'intégration, puis affichés à l'écran des crédits (IHM-08). | P0 |
| AST-03 | Tout le reste est généré, toujours en pixel art : terrain, flore, bâtiments, mini-sprites, portraits, armoiries, œuvres, éléments d'interface. | P0, puis P1 |
| AST-04 | Pipeline d'assets : sources éditables (images indexées par rôle de teinte, ou grilles de texte), recoloration à l'exécution, atlas générés à la compilation. | P0 |
| AST-05 | Bibliothèques tierces sous licences compatibles avec une sortie commerciale (MIT, BSD, Apache…). | P0 |
| AST-06 | Audio : musique et effets sonores. | P2 |

## 27. Périmètre par version

### P0 : premier jalon jouable, un mode Créateur minimal

- On génère un monde cylindrique et on l'explore avec un zoom fluide.
- On fait apparaître des humains des trois sous-espèces. Ils naissent, vivent, se reproduisent selon une génétique de base et meurent.
- Ils fondent des civilisations dotées d'une langue et d'une culture simples, puis des villages qui grandissent et transforment le terrain.
- Une économie de subsistance les fait vivre et les premiers savoirs s'inventent.
- Des gouvernements de niveaux 1 et 2 se forment ; les premières guerres sont résolues automatiquement.
- Portraits et armoiries sont générés.
- La chronique et les panneaux d'inspection permettent de tout suivre ; la partie se sauvegarde localement.

### P1 : version 1

- Modes Saga et Libre, préhistoire.
- Féodalité complète : niveaux 1 à 5, lois, vassalité, succession, testament.
- Économie de marché, banques, assurances, entreprises et immobilier.
- Arbre des savoirs complet et architecture procédurale.
- Cultures, langues et religions qui se diffusent ; arts.
- Batailles tactiques et doctrines ; diplomatie complète.
- Écrans de visualisation, arbre généalogique, graphiques, modes de carte, habillage évolutif.

### P2 : ensuite

- Nains, orques et elfes, métissages entre espèces, monstres.
- Batailles navales, catastrophes, marées, érosion.
- Complots et assassinats, ordres militaires.
- Styles héraldiques par espèce, culture et religion ; emprunts entre langues.
- Ouverture aux mods, empaquetage pour les stores, audio.

## 28. Questions ouvertes

| # | Sujet | État |
|---|---|---|
| 1 | Système de batailles : vue tactique (sur la carte à fort zoom ou dans un écran dédié), échelle de temps, moral, formations, doctrines, commandement par grade. | Séance de conception dédiée |
| 2 | Modèle de diffusion des cultures, des langues et des religions (CUL-03). | À concevoir |
| 3 | Règles d'appartenance d'un individu et d'un village à une civilisation et à une culture (CIV-04). | À concevoir |
| 4 | Dictature et anarchie : descriptions ; mode d'accès « par désignation » (POL-03). | À concevoir |
| 5 | Titres proposés : Tyrannie (dictature de niveau 4), doge (oligarchie de niveau 4), président (république de niveau 5) ; formes féminines des titres. | À valider |
| 6 | Liste des biomes anthropiques (section 6). | À valider |
| 7 | Lacs et marais : faut-il les ajouter aux biomes naturels ? Le remplissage des dépressions par l'hydrologie produit naturellement des lacs. | À valider |
| 8 | Saisons : effets sur l'agriculture, la guerre et les visuels (proposées en P1). | À valider |
| 9 | Contrôle direct en mode Saga : sur la carte, dans les écrans de visualisation, dans les batailles ? | À préciser |
| 10 | Écrans de visualisation : perspective, moteur de génération et degré d'interactivité ; l'usage des sprites originaux en dépend. | À concevoir |
| 11 | Taille de monde par défaut et nombre d'individus sur mobile. | À calibrer par prototypage |
| 12 | Apparition de la foi en Le Créateur : spontanée, rare, ou déclenchée par le joueur ? | À décider |
| 13 | Ordre de certaines chaînes du brief, par exemple bombe → canon → fusée → mousquet. | À revoir lors de l'écriture de l'arbre |
| 14 | Nom de l'auteur et lien du pack de sprites, pour les crédits. | À fournir |
| 15 | Titre du jeu. | À trouver |
| 16 | Domaines des savoirs : faut-il en ajouter (agriculture et élevage, aujourd'hui dans l'artisanat et l'industrie ; sciences et médecine ; philosophie et théologie) ? L'architecture se répartit-elle bien entre urbanisme (techniques) et art (styles) ? | À valider avec l'arbre |

## 29. Journal des décisions

Réponses au questionnaire du 8 novembre 2026. « Défaut » désigne la proposition par défaut du questionnaire, acceptée telle quelle.

| # | Sujet | Décision |
|---|---|---|
| 1 | Ambition | Projet personnel, porte ouverte à une sortie publique. |
| 2 | Organisation | Claude écrit l'essentiel du code ; l'auteur dirige, relit et teste. |
| 3 | Code | Dépôt git et Claude Code ; la conversation de conception pour le design et les prototypes. |
| 4 | Technologie | Web : TypeScript, PixiJS, Web Worker. |
| 5 | Mobile | Android et iOS, paysage en priorité, hors ligne. |
| 6 | Langue et technique | Français et traduction dès le départ ; solo ; contenu en données ; sauvegardes locales avec export. |
| 7 | Priorités | Créateur minimal, puis Saga, puis Libre. |
| 8 | Échelle | Monde continu d'est en ouest, plus grand que 256×256 ; de 10 000 à 50 000 individus. |
| 9 | Granularité | Modèle hybride. |
| 10 | Affichage | Selon le zoom ; armées réellement simulées ; batailles stratégiques (moral, effectifs, mouvements, doctrines) à approfondir. |
| 11 | Temps | Défaut : pas de temps mensuel, environ 10 s par an, préhistoire, pause aux choix. |
| 12 | Vue | 2D en tuiles de 4 px ; pas de 3D ; rendu des paysages et des villes en pixel art. |
| 13 | Biomes | Liste du prototype, enrichie de biomes anthropiques. |
| 14 | Terrain | Altitudes avec effets ; marées secondaires ; terrain évolutif, surtout par l'action humaine ; continuité est-ouest. |
| 15 | Ressources | Défaut. |
| 16 | Univers | Défaut : pas de magie au départ, monstres plus tard, plafond au XIXe siècle. |
| 17 | Espèces | Défaut, en commençant par les humains seuls. |
| 18 | Génétique | Défaut : hérédité mendélienne et polygénique ; les gènes pilotent le portrait. |
| 19 | Clans | Maisons, plus des ordres religieux avec leurs propres règles d'entrée. |
| 20 | Cultures | Défaut ; l'architecture s'intègre à l'arbre des savoirs. |
| 21 | Langues | Défaut : phonologie et lexique de racines. |
| 22 | Religions | Mono- ou polythéistes ; divinités animales, élémentaires ou géographiques ; foi en Le Créateur ; diffusion selon les niveaux. |
| 23 | Héraldique | Défaut ; styles par espèce, culture et religion plus tard. |
| 24 | Savoirs | Défaut. |
| 25 | Arts | Visuels procéduraux ; architecture sur la carte et dans les écrans de ville et de bataille. |
| 26 | Nomenclature | Tyran pour la dictature de niveau 4 ; l'anarchie n'a pas de chef ; « seigneur » conservé pour la paroisse ; propositions pour le reste. |
| 27 | Féodalité | Défaut : tout sauf les complots au départ. |
| 28 | Économie | Marchés et prix, manufactures, banques, assurances, entrepreneurs, immobilier locatif. |
| 29 | Guerre | Batailles tactiques visibles et commandables ; vrais soldats ; diplomatie complète. |
| 30 | Saga | Contrôle mixte avec contrôle direct possible ; interface de base et onglets selon les rôles. |
| 31 | Sprites | Mini-sprites dédiés à la carte ; originaux pour les écrans de visualisation et la fiche. |
| 32 | Assets | Originaux en PNG avec vêtements ; licence libre avec attribution ; tout le reste généré en pixel art ; meubles à refaire. |
| 33 | Événements | Défaut. |
| 34 | Fin de partie | Proche au choix ; héritage selon la culture, la civilisation et le testament. |
| 35 | Interface | Oui à tout ; habillage évolutif selon le niveau de la civilisation. |

Corrections de la relecture (version 0.2) :

| Sujet | Décision |
|---|---|
| Monde | Monde cylindrique validé. |
| Sprites | Les originaux ne sont pas obligatoires ; leur usage dépendra du moteur de génération des écrans de ville et de bataille. |
| Civilisation et culture | Notions distinctes : plusieurs cultures par civilisation, une culture dans plusieurs civilisations. |
| Savoirs | Domaines distincts : politique, économie, art, artisanat et industrie, urbanisme, militaire, langage, marine… |
| Gouvernements | Chaque gouvernement a un type et un mode d'accès au pouvoir. |
| Dépôt | Public, sur GitHub. |

## 30. Glossaire

| Terme | Définition |
|---|---|
| Biome anthropique | Biome créé par l'activité humaine (bocage, grandes cultures, terre brûlée…). |
| Blasonnement | Description d'armoiries en langage héraldique. |
| Brisure | Modification des armoiries qui distingue une branche cadette. |
| Chronique | Journal de tous les faits notables du monde. |
| Civilisation | Peuple issu d'une fondation, porteur de la maîtrise des savoirs ; elle peut compter plusieurs cultures. |
| Culture | Ensemble de coutumes, associé à une langue ; elle peut être présente dans plusieurs civilisations. |
| Écartelé | Écu divisé en quatre quartiers, qui réunit plusieurs armoiries. |
| Maison | Lignée notable dotée d'un nom, d'armoiries et d'un chef ; le « clan » du brief. |
| Maîtrise | Degré de connaissance d'un savoir par une civilisation, de 0 à 100 %. |
| Métal, couleur | Or et argent sont des métaux ; gueules, azur, sinople, sable et pourpre sont des couleurs. On ne pose jamais métal sur métal ni couleur sur couleur. |
| Meuble | Figure posée sur un écu (lion, lys, tour…). |
| Mixel | Mélange de densités de pixels dans une même image, à éviter. |
| Mode d'accès au pouvoir | Façon dont le dirigeant d'un gouvernement est choisi (héréditaire, aristocratique, démocratique, ploutocratique, aléatoire), indépendante du type. |
| Niveau de gouvernement | Rang de 1 à 5 d'un gouvernement, selon sa capitale et ses vassaux. |
| Notable | Individu qui bénéficie d'une simulation détaillée. |
| Pas de temps | Unité de temps de la simulation : un mois par défaut. |
| Type de gouvernement | Monarchie, république, oligarchie, dictature, théocratie ou anarchie ; il détermine la nomenclature. |
