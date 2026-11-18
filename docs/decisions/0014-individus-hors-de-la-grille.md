# ADR 0014 — Individus hors de la grille

Statut : proposé, en cours de réalisation · 18 novembre 2026 · tâche 2b.3 ; les écarts et interprétations de la dernière section sont à soumettre à l'auteur. La critique de cette conception a demandé des changements, qui priment sur elle ; ce document dit ce qui est fait, à mesure que la réalisation avance (étape (a) : simulation, worker, protocole et données).

## Contexte

La consigne de 2b.3 fait foi (`docs/design/corrections-phase-2.md`) : chaque individu a une position continue, en cases et fractions de case ; sa taille et sa résolution d'affichage lui sont propres, converties en pixels au rendu selon le zoom, jamais contraintes à un multiple de la case ; même en groupe, chacun est une entité distincte, et les membres d'un groupe ne se rangent plus en grappe. Le sous-pas quotidien de 2b.2 ne recalcule que les positions et les activités des individus actifs (ADR 0013) ; 2b.8 tirera de l'activité un mouvement visible, pour les seuls visibles ; 2b.5 apportera les humains des planches et leurs versions réduites. Les tuiles ne changent pas.

L'auteur a tranché le 18 novembre, après une première conception rejetée : la position d'un individu est une variable de la simulation, et non du rendu ; la marche des groupes de 2b.2 n'a pas de sens dans ce jeu ; les mouvements sont individuels, grégaires en l'absence de ville ou de civilisation, et selon l'individu. La première conception faisait de la position une fonction pure calculée au rendu, et gardait les membres en file sur le chemin du groupe : tout ce qui en dépendait est abandonné. En sont repris, corrigés des défauts que sa critique y a mesurés, la stature tirée des données, la densité commune des individus d'une vue, le seuil des individus et l'appui.

Aujourd'hui, un groupe parcourt jour après jour le chemin que le pas mensuel a noté (`state.walks`), et ses membres se dessinent en spirale autour de lui (`clusterOffset`).

Les chiffres ci-dessous viennent d'un prototype hors du dépôt, branché sur la vraie simulation : vrais systèmes mensuels, vrai contenu, plus le trait de grégarité. Ils ont été mesurés dans ce conteneur de quatre cœurs, sur deux scénarios :
- trois graines (`graine`, `autre`, `pixelciv`) de cent groupes de trente sur un monde Petit, pendant 120 mois (le scénario de `src/sim/state.test.ts`) ;
- 50 000 puis 20 000 individus en groupes de 25, semés comme dans le banc d'essai sur un monde Immense (graines `banc-population`, `graine` et `autre`).

## Décision

### 1. L'état

- **Position.** Deux colonnes des vivants, `x` et `y` (Int32), en 1/65 536 de case (virgule fixe 16.16). La case (i, j) couvre [i, i + 1[ × [j, j + 1[, comme dans l'ADR 0013 ; x ∈ [0, largeur × 2^16[ et y ∈ [0, hauteur × 2^16[. La virgule fixe rend l'état exact et compact : la couture est un modulo entier, une étape avance d'une addition entière par jour, et sauvegarde, empreinte et messages copient des entiers. Les décisions (direction, durée d'une étape, place) se calculent en flottants, par les seules additions, soustractions, multiplications, divisions et racines carrées (`Math.sqrt`, jamais `Math.hypot`), puis s'arrondissent par `Math.round`. Aucune trigonométrie : une direction tirée au sort l'est par rejet dans le disque unité, à partir de deux tirages uniformes ; `dmath` n'est donc pas requis. Toute abscisse revient dans [0, largeur × 2^16[ après chaque addition, et tout écart horizontal se prend au plus court, dans [−largeur × 2^15, largeur × 2^15[.
- **Mouvement propre**, dans les colonnes des vivants :
  - `move` (Uint8), l'intention : au repos, en partance, en marche, ou porté ; un bit note le détour (§ 3), un autre le retard, c'est-à-dire une marche commencée un mois précédent ;
  - `depart` (Uint8), le jour du départ de qui est en partance ;
  - `goalX` et `goalY` (Int32), la place visée ;
  - l'étape en cours : `stepX` et `stepY` (Int32), le déplacement par jour, et `stepDays` (Uint16), les jours restants. La fin de l'étape vaut exactement la position plus `stepDays` pas.

  L'allure ne se stocke pas : elle se déduit de l'individu (§ 3). Un vivant passe de 76 à 104 octets ; 2b.8 ajoutera l'activité.
- **Groupe.** Il gagne `campX` et `campY`, la case du camp que choisit son guide (§ 3). `x` et `y` gardent leur sens, la case où se tient le groupe au pas mensuel ; elle se déduit désormais de ses membres.
- **Sauvegarde et empreinte.** Ces colonnes et ces champs y entrent tels quels : `fingerprintPeople` parcourt déjà toutes les colonnes. Les structures qui s'en déduisent sont des caches, reconstruits au chargement, hors de la sauvegarde et de l'empreinte : liste des actifs, départs par jour, grille des gens au repos, places réservées, nourrissons de chaque mère, champs de détour.

### 2. Le sous-pas quotidien

- **Actifs.** Ce sont les marcheurs, et les nourrissons que portent les marcheuses : ils prennent la position de leur mère. Les gens au repos ne coûtent rien, et ceux en partance attendent dans la liste de leur jour de départ, dressée au pas mensuel. La liste des actifs se tient sans parcourir les vivants : un départ y entre, une arrivée en sort. Chaque marcheur avance sans lire les autres : l'ordre de la liste ne change rien à l'état, et elle se reconstruit au chargement dans n'importe quel ordre. Les deux systèmes qui lisent les autres passent dans un ordre canonique (étapes 5 et 6 ci-dessous).
- **Ordre fixe d'un jour :**
  1. les commandes, comme dans l'ADR 0013 ;
  2. les départs du jour : chacun calcule sa première étape ;
  3. (2b.8 : les activités) ;
  4. la marche : une étape avance d'une addition ; à la fin d'une étape, la suivante se calcule (§ 3) ; les portés suivent leur mère ;
  5. l'espacement, un jour sur deux (`walkers.every`). Les marcheurs se trient par case, puis par emplacement, et ceux d'une même case se comparent deux à deux ; le second d'une paire à moins de 0,25 case (`walkers.gap`) s'écarte de côté, de 0,3 case au plus (`walkers.aside`), si le segment du jour, depuis sa position de la veille, reste libre, puis recalcule son étape le lendemain. Tous décident d'après les positions du jour, puis s'écartent ensemble ;
  6. les arrivées, par emplacements croissants. Chacun se pose à sa place si personne au repos ne s'y tient à moins de 0,45 case (`camp.gap`) ; sinon, il tire une autre place libre ;
  7. le jour suivant, ou le pas mensuel le trentième jour.
- **Tirages.** Un seul flux nouveau, `sim.camp`, sert aux places, aux jours de départ et aux places reprises à l'arrivée ; la marche et l'espacement ne tirent rien. Aucun autre flux n'en est décalé.
- **Coût mesuré.** Un marcheur en milieu d'étape coûte une addition. Le coût vient donc des trajets, et non des jours de marche : calcul des étapes (1 700 par jour à 50 000 individus), arrivées (1 100), tri de l'espacement et écarts (420). Les pointes tombent les jours de départ qui suivent le pas mensuel, jusqu'à 20 000 étapes.

  | Vivants | Actifs par jour, en moyenne et au plus | Un jour : moyenne, 95e centile, au plus | Pas mensuel | Mois entier (30 jours et le pas) | 2b.2 : un jour, un mois entier |
  |---|---|---|---|---|---|
  | 2 300 à 3 000 (3 graines) | 44 à 49 %, et plus de 90 % | 0,25 à 0,29 ms | 9,8 à 10,5 ms | 17 à 19 ms | — |
  | 19 400 | 58 %, et 100 % | 1,7 ms, 4,6 ms, 8,0 ms | 68 ms | 119 ms | 0,06 ms et 39 ms |
  | 48 000 à 48 500 (3 mondes) | 55 à 60 %, et 100 % | 4,7 à 5,1 ms, 11 à 14 ms, 21 à 23 ms | 160 à 186 ms | 306 à 328 ms | 0,10 à 0,20 ms, et 81 à 95 ms |

  Le pas mensuel du prototype paie surtout son plan des départs : de 70 à 88 ms à 50 000 individus, écrit avec des tables associatives et des fermetures, que l'implémentation remplacera par des tableaux typés. Le lieu des groupes coûte de 6 à 9 ms, et les champs de détour 3 ms.

### 3. Le mouvement

**Grégarité (réalisé).** C'est un trait de caractère acquis (IND-07), et non un gène : IND-05 énumère les gènes, et IND-07 range les traits de caractère parmi les traits acquis, distincts d'eux. Elle n'occupe donc aucun des huit octets de traits du génome, que les mods gardent libres. C'est une colonne des vivants, `gregariousness` (Uint8, de 0 à 255), copiée dans l'archive pour la fiche. Elle se tire à la naissance et à l'apparition sur un flux propre, `sim.temper`, deux tirages uniformes par individu, si bien qu'elle ne décale aucun autre flux : sans le mouvement, la démographie des trois graines reste identique à celle de 2b.2 après 120 mois (2 383 vivants et 170 groupes pour `graine`, 2 682 et 175 pour `autre`, 2 921 et 186 pour `pixelciv`). Chaque sous-espèce en donne la répartition (`temperament.gregariousness` de `data/species.json`, moyenne 0,5 et écart type 0,2) ; un métis tire dans la moyenne de celles de son ascendance, et l'enfant tient en partie de sa mère, par l'éducation : sa grégarité vaut `upbringing` (0,3) × celle de sa mère, plus (1 − `upbringing`) × son tirage. Une sauvegarde qui ne la connaît pas donne à chacun la moyenne de son ascendance. La fiche la montre en niveau, comme les traits. Le contexte la module (`data/nomads.json`, `camp.cohesion`, 0,5) : la grégarité effective vaut g' = 1 − (1 − g) × (1 − c), si bien que, dans un groupe nomade, la personne la plus solitaire vaut encore 0,5. La phase 3 donnera aux villages leur propre cohésion, plus faible. En 2b.3, la grégarité règle le jour du départ, la place au camp et l'allure.

**Un jour d'un individu très grégaire, puis d'un peu grégaire.** Mesuré sur les trois graines, en classes de g' : moins de 0,7 (trait sous 0,4) et 0,8 ou plus (trait de 0,6 ou plus).
- *Très grégaire.* Quand le guide annonce un nouveau camp, il part avec lui : le jour 0,35 en moyenne, et le jour 1 au plus pour neuf sur dix. Il se pose près du centre, à 0,8 ou 0,9 case du barycentre de son camp en médiane.
- *Peu grégaire.* Il s'attarde à l'ancien camp, et part le jour 1,5 ou 1,6 en moyenne, le jour 3 ou plus tôt pour neuf sur dix, le jour 5 au plus. Il marche souvent seul, et se pose en bordure, à 1,1 ou 1,2 case du barycentre en médiane, jusqu'à trois cases. S'il marche encore au pas mensuel, il presse le pas vers le nouveau camp.
- *Entre deux trajets.* En 2b.3, chacun se tient à sa place, faute d'activités (2b.8).

**Qui choisit le camp : trois modèles.**
- *(a) Un guide choisit le camp, et chacun s'y rend à sa façon.* Une seule évaluation par groupe et par mois : la fonction et les tirages de `moveGroup`, parce que la nourriture reste une affaire de groupe (C2, D4).
- *(b) Un conseil des adultes.* Chacun évaluerait ses propres cases, et le groupe suivrait la majorité. Cela ferait dix fois plus d'évaluations et de tirages, pour une même issue tant que l'économie reste celle du groupe. Si chacun suivait son propre choix, le groupe se disperserait sans se scinder.
- *(c) Un essaim sans but.* Cohésion, séparation et gradient local de nourriture : tout émergerait, mais rien ne garantirait le déplacement « au fil des saisons vers les meilleurs terrains de son aire ». Il faudrait juger la nourriture par individu et par jour, et chercher les voisins de chacun chaque jour.

Le modèle (a) est retenu : il tient D4 à son coût d'aujourd'hui, laisse la démographie dans le bruit (voir plus bas), et tout ce qui se voit y est individuel. Le guide est le meneur s'il vit dans le groupe, sinon l'aîné de ses adultes ; le groupe garde le nom de son meneur (ADR 0011). Le guide évalue comme `moveGroup` aujourd'hui : les mêmes dix cases, tirées sur `sim.groups` autour du lieu du groupe, la même valeur, nourriture et aire, et le même budget. Le camp est la case qu'atteint `walk` dans ce budget, sans noter de chemin. Si le guide reste, le camp ne change pas, et personne ne bouge. Le camp d'un groupe né d'une scission est la case qu'atteint `walk` vers sa nouvelle aire. Le guide part le jour 0.

**Chacun s'y rend.**
- *Sa place.* Il garde, à 0,15 case près, tirée au sort, sa place par rapport au camp : sa position, moins le centre de l'ancien camp, plus celui du nouveau. Elle doit être libre (aucune personne au repos ni place réservée à moins de 0,45 case), sur la terre du camp, et en vue de son centre (segment libre). Sinon, il tire une place dans un disque autour du centre du camp, de rayon (0,3 + 1,4 × (1 − g')) × 0,45 × √n pour un groupe de n membres (`camp.inner`, `camp.outer`, `camp.spread`). Garder sa place rend les trajets parallèles : avant tout contrôle d'espacement, des places neuves à chaque camp mettaient 8,5 % des marcheurs à moins de 0,15 case d'un autre, et les places gardées 5 %. Chaque place visée est réservée : seules 2,3 % des arrivées trouvent encore la leur prise, et en tirent une autre ; 0,1 % se posent faute de mieux trop près d'un autre.
- *Son jour.* Le guide part le jour 0 ; un enfant, le jour de sa mère ; les autres, le jour ⌊6 × 2(1 − g') × u⌋, où u est tiré au sort (`camp.lag`, 6 jours au plus).
- *Sa route, par étapes droites.* Il vise sa place en ligne droite si la voie est libre. Les cases que traverse le segment se cherchent avec la règle du coin, et la couture ; le coût de chacune se compte au prorata du chemin qu'il y fait. Sur l'étape, sa vitesse est constante : son allure divisée par le coût moyen de l'étape. Si la ligne bute, il marche jusqu'au bord ; puis il passe à la case voisine qui le rapproche le plus, selon la règle de `walk` ; et si aucune ne le rapproche, il descend le champ de distances du camp de son groupe. Ce champ est un Dijkstra borné à 40 cases du camp, calculé à la première demande et prolongé au besoin ; ses valeurs sont les distances exactes, si bien qu'elles sont les mêmes après un chargement. Mesuré : 90 % des étapes vont en ligne droite, les autres contournent un obstacle case par case ; de 1,1 à 1,4 % des trajets passent par un champ, et les champs coûtent 1 ms par mois à 3 000 individus, 3 ms à 50 000.
- *Son allure.* Celle du budget de marche du groupe (`walkBudget`), appliquée à chacun : nomads.walk / 30 × (0,8 + 0,4 × l'endurance de son ascendance). En plaine, cela fait une case par jour (C2, D13 ; mesuré : 1,04 en médiane, de 1,00 à 1,08), avant les coûts du biome et de l'altitude : tous terrains confondus, 0,46 à 0,56 case par jour en médiane, pour un coût médian de 1,9 à 2,3 par case parcourue. L'enfant marche à l'allure de sa mère. Qui marche encore au pas mensuel presse le pas (`camp.hurry`, 1,25).
- *Ses trajets.* 15 ou 16 jours en médiane, de 33 à 44 jours au 95e centile ; l'arrivée tombe vers le 14e ou le 15e jour du mois. De 5,7 à 8,4 % des départs marchent encore au pas mensuel suivant : leur but passe alors au nouveau camp, place gardée.
- *Le terrain.* Les coûts sont ceux de la marche de 2b.2 (`state.cost`). Un individu ne se tient jamais sur une case infranchissable, n'en traverse jamais, et ne coupe jamais un coin, couture comprise. Le segment de chaque jour est droit et vérifié : le rendu, qui interpole sur ce segment d'un jour à l'autre, ne coupe pas l'eau.

**Espacement.**
- *Au repos.* Les places sont réservées, et vérifiées à l'arrivée. Mesuré sur les trois graines : 99,5 % des personnes au repos sont à 0,45 case au moins de toute autre personne au repos, et 0,06 à 0,2 % à moins de 0,2. Les places viennent de la disposition gardée, d'un écart tiré au sort et de tirages dans un disque : aucune spirale, aucun motif. Aucun coût quadratique : les grilles sont par case, et une requête n'y visite qu'une à quatre cases.
- *En marche.* La disposition gardée et le contrôle par case d'un jour sur deux laissent 1,6 % des marcheurs à moins de 0,15 case d'un autre, et 0,3 % des jours de marche se passent à moins de 0,2 case d'un même voisin trois jours de suite ou plus ; sans eux, c'était 8,5 % et 4,8 %. Deux variantes ont été écartées. L'évitement quotidien de chaque marcheur, par une grille, donnait 0,2 % pour 3,7 ms de plus par jour à 50 000 individus. L'attente d'un jour au départ, quand une route en longerait une autre, ajoutait 1 ms par jour, et la gagnait moins.
- *Les camps.* Le rayon quadratique d'un camp posé vaut 1,1 à 1,2 case en médiane, et son membre le plus éloigné se tient à 1,7 ou 1,8 case du barycentre en médiane, 2,7 ou 2,8 au 95e centile. En route, ce membre se tient à 2,1 ou 2,2 cases en médiane, et à 3,4 cases au 95e centile.

**Naissances, morts, changements de groupe.**
- *Naissance.* Le nourrisson est porté jusqu'à l'âge `ages.baby`, tant que sa mère vit dans son groupe : il prend sa position, ne compte pas dans l'espacement, et se dessine contre elle (§ 6). Sevré, il descend à 0,3 case d'elle, sur un segment libre, puis gagne une place près d'elle. Né orphelin, sa mère morte en couches, il paraît au centre du camp et gagne une place.
- *Mort.* Le mort disparaît là où il se tenait, au pas mensuel ; personne ne bouge, et sa place se libère.
- *Changement de groupe.* Qui change de groupe reste où il est au pas mensuel, puis marche, dès le jour 0, jusqu'au camp de son nouveau groupe, avec ses jeunes enfants. Cela vaut pour tous les membres d'une réunion, pour le conjoint d'un mariage et pour les partants d'une scission. Le voisinage borne la distance à un mois de marche (ADR 0011), un peu plus avec les détours. Le pas mensuel relève, à son début, le groupe de chacun, dans un tableau qui ne sert que le temps du pas : le plan du mois y voit qui a changé de groupe, sans rien garder dans l'état. Un membre se met en route, ou change de but, si son groupe a changé, ou si le camp de son groupe a changé ce mois-ci. Rien ne saute.

**Lieu du groupe et pas mensuel.**
- *Le lieu.* C'est la case du membre le plus proche du barycentre de ses membres. Les écarts se prennent au plus court, par rapport au premier membre dans l'ordre des emplacements ; à égalité, le premier l'emporte. Ce lieu est toujours franchissable, et sur la terre du groupe. Il se calcule au début du pas mensuel, avant la repousse : nourriture, aire, climat du cycle de vie, voisinage, réunions, scissions et chronique le lisent. La fiche applique la même règle, à la demande, aux positions du jour. La bannière se pose au barycentre (§ 5). L'économie ne change pas : stocks du groupe, pris dans un disque autour de son lieu.
- *L'ordre.* Lieu des groupes (nouveau, sans tirage), repousse, cueillette, cycle de vie (le nouveau-né paraît à la position de sa mère, sans tirage), réunions, scissions (le camp du nouveau groupe), camps (`moveGroup`, sans chemin noté), puis le plan du mois (nouveau, sur `sim.camp`) : sevrages, places et jours de départ. Les flux `sim.groups`, `sim.deaths` et `sim.couples` tirent comme avant. Un flux nouveau, `sim.temper`, tire la grégarité de chaque naissance et de chaque apparition ; `sim.births` et `sim.spawn` tirent comme avant.
- *La démographie après 120 mois*, en vivants et en groupes :

  | Graine | 2b.2 | 2b.2 et trait de grégarité | Prototype |
  |---|---|---|---|
  | `graine` | 2 383, 170 | 2 386, 169 | 2 358, 161 |
  | `autre` | 2 682, 175 | 2 769, 183 | 2 767, 187 |
  | `pixelciv` | 2 921, 186 | 2 956, 182 | 2 987, 188 |

  Les vivants varient de −1,0 à +3,2 %, et les groupes de −5 à +7 %. Ajouter le seul trait, qui décale les tirages des naissances, les fait varier autant (de +0,1 à +3,2 % de vivants) : l'effet du modèle reste dans le bruit d'un autre tirage.

### 4. Ce que devient la marche des groupes de 2b.2

- **Retiré.**
  - `state.walks` et `src/sim/walks.ts` : `Walks`, `WalkRecorder` et `DayPositions`, ainsi que `rebuildPositions` ;
  - `walkPosition` et les marches de `src/core/walk.ts`, que seule garde, en interne, la migration de la sauvegarde 6 ;
  - le paramètre `record` de `walk`, et la marche que notent `moveGroup` et `splitGroup` ;
  - les cinq tableaux de marches de la sauvegarde 6, qui ne se lisent plus qu'à sa migration, et leur part de l'empreinte ;
  - les marches de l'image des groupes du protocole 5 ;
  - dans `src/app/frames.ts`, `walkOf` et `walkDay` ;
  - dans `src/render/crowd.ts`, `groupPositions`, `clusterOffset`, `clusterReach` et `memberBox` ;
  - le nombre de marches en cours de `StepStats`, qui devient le nombre de marcheurs.
- **Remplacé.** La marche d'un groupe devient le trajet de chacun (§ 3), et la position du groupe, celle de ses membres. Les garanties de l'ADR 0013 tiennent :
  - l'état ne dépend ni de la vitesse ni du regroupement des jours, puisque le jour reste l'unité et que ses systèmes sont indépendants de l'ordre, ou passent dans un ordre canonique ;
  - une commande s'applique au début du jour suivant ;
  - le rejeu se fait jour par jour ;
  - le pas mensuel tombe au soir du trentième jour ;
  - le rendu interpole entre deux jours, sur les segments vérifiés de chaque jour.

### 5. Protocole 6

- **Tous les individus, par leurs étapes.** Le worker n'envoie pas une position par jour et par marcheur, mais chaque étape quand elle commence ; le fil principal en tire exactement les mêmes positions que le worker, par les mêmes additions entières. Une étape tient en 28 octets : emplacement, jour de départ, point de départ, pas et nombre de jours. Rien n'est quantifié : point et pas sont les entiers 16.16 de l'état ; l'emplacement désigne l'individu, et l'image des groupes le relie à son identifiant. Il n'y faut aucun message pour une arrivée, qui est la fin d'une étape. Un écart de côté est une étape d'un jour. Les autres solutions sont écartées :
  - les positions quotidiennes de tous les marcheurs : 12 octets par marcheur et par jour, soit 350 Ko par jour à 50 000 individus, et 50 Mo/s à ×16 ;
  - les seuls individus de la vue, que le fil principal signalerait au worker : il faudrait renvoyer la vue à chaque déplacement, recevoir des instantanés de région, et accepter des individus qui paraissent en retard au panoramique rapide.
- **L'image des groupes**, quand elle change : au pas mensuel, et après une commande qui change les groupes. Elle garde ses cinq valeurs par groupe (`GROUP_STRIDE`) : identifiant, lieu, membres, culture. Elle porte, membre par membre, l'emplacement (Uint32), l'identifiant (Uint32), le code d'apparence (Uint16), la stature (Uint8, § 6) et la position (Int32 × 2), ainsi que l'étape en cours de chaque marcheur. Elle pèse 19 octets par membre, plus 28 par marcheur : 0,9 à 1,0 Mo à 50 000 individus, 4,8 fois par seconde au plus à ×16, soit 4,8 Mo/s.
- **Le delta de chaque lot** porte, en plus du temps, des blocs et des faits, les étapes commencées pendant ses jours, chacune datée de son jour : à ×16, un lot de trois jours apporte celles de ses trois jours. Volume moyen : 3 Ko par jour à 3 000 individus, 60 Ko à 50 000 individus (2 100 étapes, écarts compris), soit 8,5 Mo/s à ×16. Au pire, le premier jour d'un mois, 20 000 étapes pèsent 560 Ko.
- **Tampons.** Image et étapes voyagent en tableaux typés transférés. Le fil principal rend les tampons lus (message `recycle`) ; le worker les garde, par taille, pour les lots suivants.
- **Fil principal.** Il tient, par emplacement, la position de l'image de l'instant affiché et l'étape en cours. Les étapes reçues attendent leur jour dans une file datée, comme les images (`FrameQueue`). À l'instant t affiché, la position vaut départ + pas × min(t − jour de départ, jours). L'interpolation entre deux jours suit donc l'étape, qui ne coupe pas l'eau. En pause, l'instant s'arrête, et tout aussi. Changer de vitesse ne change rien aux étapes. Au panoramique rapide, tout est déjà connu.
- **Bannières.** Chaque bannière se pose au barycentre des membres de son groupe, à l'instant affiché, écarts pris au plus court ; si ce point tombe sur l'eau, elle se pose au membre le plus proche. Le fil principal le calcule, en vue lointaine seulement.

### 6. Taille, résolution et rendu

- **Stature.** C'est la hauteur de l'individu debout, en cases : la stature de référence de son espèce, celle d'un adulte de taille moyenne (`display.stature` de `data/species.json`, proposée à 0,75 case) ; fois sa croissance (`display.growth`, part de la stature adulte selon l'âge, linéaire par morceaux) ; fois sa taille (trait de rôle `height`) sur la taille moyenne de l'espèce. Le worker l'envoie en 1/128 de case. Le schéma exige qu'elle tienne sur un octet : stature × croissance maximale × 2 × height[1] / (height[0] + height[1]) ≤ 255/128.
- **Résolution et conversion.** Chaque motif a sa grille de pixels : aujourd'hui, le mini-sprite, de 9 rangées pour l'adulte, 7 pour l'enfant et 6 pour le nourrisson. À l'échelle s (`displayScale`), une case fait 4s pixels physiques, et l'adulte de référence vise 0,75 × 4s pixels. La vue prend un entier k ≥ 1, le même pour tous ses individus, arrondi de cette cible sur 9. Chaque individu se dessine en r × k pixels physiques de haut, où r est le nombre de rangées de sa variante, au plus proche, les pieds sur sa position arrondie au pixel physique. La variante se choisit sur la cible non arrondie, r = arrondi(stature / stature de référence × 9), dans les variantes de sa classe d'âge : 8 à 10 rangées pour l'adulte, 6 à 8 pour l'enfant, 6 pour le nourrisson. Elle ne dépend donc ni de k ni du zoom : c'était le défaut de la première conception. Les variantes s'obtiennent en doublant ou en ôtant une rangée désignée de la source. La taille propre se voit surtout à la croissance des enfants, et aux extrêmes : une rangée de plus ou de moins ne distingue qu'un adulte sur cinq environ, comme l'a mesuré la critique de la première conception. Ni la taille ni la position ne s'alignent sur la case.

  Hauteur d'un adulte de taille moyenne, en pixels CSS (avec k) :

  | Zoom | 3 | 4 | 8 | 16 | 24 |
  |---|---|---|---|---|---|
  | Aujourd'hui | 27 | 36 | 72 | 144 | 216 |
  | Densité 1 | 9 (k = 1) | 9 (1) | 27 (3) | 45 (5) | 72 (8) |
  | Pixel 5 (densité 2,75) | 9,8 (3) | 13,1 (4) | 22,9 (7) | 49,1 (15) | 72 (22) |

- **Une densité par vue.** CLAUDE.md et REN-08 demandent une seule densité de pixels par vue. Interprétation proposée : les tuiles et les bannières gardent la densité de la carte, et tous les individus d'une vue partagent la leur, k, plus fine dès l'échelle 3 ; deux densités ne se mêlent jamais dans un même dessin, ni d'un individu à l'autre. REN-04 tient au seuil de la vue rapprochée : de 6 à 10 pixels, un pixel physique par pixel de motif, à la densité 1. Le décor et le gibier de 2b.6 prendront la densité des individus.
- **2b.5.** Les humains des planches et leurs versions réduites entreront comme niveaux de motifs, déclarés avec l'atlas. La vue prend le plus fin dont k reste à 25 % de la cible, sinon le plus proche ; ses variantes de hauteur seront à 2b.5 de les fixer, trois au plus.
- **Niveaux de détail.** De loin, la bannière de chaque groupe, inchangée (ADR 0010). De près, chaque individu, dès que l'adulte de référence vise 8 pixels CSS : à partir du zoom 3 à la densité 1, comme aujourd'hui, et du zoom 2,9 sur Pixel 5, si bien que le zoom 3 d'ouverture du téléphone montre les individus. Le nourrisson porté se dessine contre sa mère, d'un côté tiré de son rang parmi les portés ; le marcheur, dans ses deux images de marche, selon le jour de son étape.
- **Tri.** Le plus bas à l'écran passe devant, d'après les pieds, puis le dernier dessiné (`depth`) ; le porté passe juste devant sa mère.
- **Appui.** On touche ce qu'on voit. La tolérance vaut 4 pixels CSS pour un pointeur fin et 12 pour le doigt. Un individu touché, ou frôlé, ouvre sa fiche (IHM-02), d'où l'on gagne celle de son groupe ; à égalité, celui de devant l'emporte. Faute d'individu, un appui dans la boîte des membres d'un groupe, marge comprise, ouvre la fiche du groupe ; sinon, la case. Sur Pixel 5 au zoom 3, un adulte dessiné fait 9,8 × 6,5 pixels CSS, et sa cible au doigt 34 × 31. L'outil d'apparition refuse une case où se tient quelqu'un.
- **Coût.** Le pire cas tombe au seuil de la vue rapprochée. Sur un écran de 1 920 × 1 080 tout en terres, à la densité de 50 000 habitants sur un monde Grand, quelque 4 000 individus sont visibles, et 12 000 dans une région trois fois plus peuplée ; sur Pixel 5, 700 à 2 000. Les sprites et leurs textures recolorées se réutilisent. Le critère vise 60 images par seconde sur PC avec 4 000 individus visibles, et 30 sur Pixel 5, processeur ralenti ×4, avec 2 000. En deçà, les textures passeront dans un atlas dynamique pour dessiner par lots ; la décision se prend sur la mesure de l'étape (b).

### 7. Sauvegardes, rejeu et empreintes

- **Version 7.** Les colonnes de position et de mouvement entrent dans celles des vivants, et `campX` et `campY` dans les groupes. La relecture vérifie, sans juger la franchissabilité, qui suit un contenu qui a pu changer (ADR 0007) :
  - les positions et les places dans le monde ;
  - l'intention et ses bits, et le jour de départ de 0 à 29 ;
  - une étape bornée : 1 000 jours au plus, et une fin dans le monde ;
  - pour un porté, une mère vivante du même groupe ;
  - les camps dans le monde.
- **Migration de la version 6.** Elle calcule, d'après les marches de la sauvegarde, la position du jour de chaque groupe, et la note dans les données JSON. La relecture, qui a le contenu, pose alors les membres au repos autour de cette position, par le placement des apparitions, sur `sim.camp`, les nourrissons portés. Le camp est la case du groupe, au bout de sa marche de 2b.2 : si la position du jour n'y est pas, chacun s'y met en route le jour même, place gardée. Les tableaux de marches sont ensuite oubliés. Une partie migrée continue de façon déterministe, mais ne rejoint plus son rejeu : le journal, rejoué par les règles de 2b.3, ne redonne pas l'histoire faite par celles de 2b.2.
- **Rejeu.** Il ne change pas : jour par jour, jusqu'à un instant.
- **Empreintes.** Vérifié à la base (1eb5244) : les trois références de `src/sim/state.test.ts` redonnent 91fb9419, 24f9fb6b et 8049a7e6. Elles changeront pour deux raisons.
  - La structure de l'empreinte change : colonnes nouvelles, camps des groupes, flux `sim.camp`, et marches retirées. C'est la seule raison pour l'an sans population.
  - Le déroulement change : le lieu des groupes se déduit des membres, et le trait de grégarité se tire à chaque naissance et à chaque apparition.

  Pour le tracer, l'étape (a) ajoute d'abord le seul trait, et note les références qu'il donne ; elle ajoute ensuite le mouvement, et note les dernières. Celles du banc d'essai sont à remesurer.

### 8. Les branchements à venir

- **2b.8.** Une colonne `activity`, fixée chaque jour par un système qui tourne avant la marche, sur son propre flux (`sim.activities`). L'activité règle l'intention : « suivi du groupe » met en partance quand le camp change, « repos au camp » laisse au repos. Cueillette, chasse, pêche, corvée d'eau et jeu gardent la place comme ancre de l'état, et leur mouvement visible est une animation déterministe tirée de l'activité, de l'identifiant, du jour et de l'ancre, que le rendu calcule pour les seuls visibles. Seuls les effets, comme une prise de chasse, sont un état, calculé dans le worker. Il reviendra à 2b.8 de décider si l'activité se tire pour tous chaque jour (de l'ordre de 1 ms à 50 000 individus) ou se déduit de l'état.
- **Phase 3.** Les villages auront leur cohésion, plus faible : chacun s'y déplacera pour son compte, sa maison comme ancre, et ses champs comme buts ou comme activités. Les temps de trajet en jours (« trois semaines de marche », C2, D13) se liront sur les mêmes coûts et les mêmes champs de distances, ceux des territoires (D14). Seuls les groupes nomades garderont un guide et un camp.

## Conséquences

- **Ce qui ne saute plus.** Réunions, mariages, scissions, naissances et morts se font à pied, ou sur place ; chacun est une entité distincte.
- **Coût.** Le jour coûte selon les trajets : 4,7 à 5,1 ms à 50 000 individus, contre 0,1 à 0,2 ms en 2b.2. Le seuil du banc, 0,5 ms par jour à 50 000 individus (ADR 0013), ne tient plus. Proposé : un garde-fou de 6 ms par jour, pour une cible de 3 ms, et le seuil de 208 ms du pas mensuel, inchangé (160 à 186 ms dans le prototype, pour une cible de 120 ms). Un mois entier à 50 000 individus prend 306 à 328 ms dans ce conteneur, contre 208 ms pour un mois à ×16 : ×16 y tournerait aux deux tiers de sa vitesse. À 20 000 individus, 119 ms, il tient. À mesurer sur un vrai PC (IND-03).
- **Mémoire et volume.** 28 octets de plus par vivant. Messages au pire, à 50 000 individus et ×16 : 8,5 Mo/s d'étapes en moyenne, avec des pointes de 560 Ko le premier jour d'un mois, et 4,8 Mo/s d'images des groupes.
- **Génome.** La grégarité, trait acquis, n'y prend aucune place : le génome garde son huitième octet de trait libre. Le trait de rapidité (IND-05), jusqu'ici sans emploi, reçoit le rôle `speed`, qui règle l'allure (§ 3).
- **Révisions.** À la réalisation, les ADR 0003 (empreinte), 0004 (protocole 6), 0007 (sauvegarde 7), 0010 (individus et appui), 0011 (positions, image des groupes, grégarité) et 0013 (marche des groupes retirée, seuils du banc) seront révisés, avec l'index et `docs/BACKLOG.md`.

## Écarts et interprétations à soumettre à l'auteur

- **Écarts.**
  - CLAUDE.md (« Pixel art ») et REN-08 : la vue rapprochée montre deux densités, celle de la carte et celle des individus, comme le veut la consigne.
  - REN-04 : des mini-sprites « à l'échelle de la carte », de 6 à 10 pixels, au seuil seulement.
  - ADR 0013 : la position par individu est un état du worker. Son seuil de 0,5 ms par jour cède. L'image des groupes porte les positions et les étapes, et non l'identifiant de chaque membre et la case d'origine des transferts qu'il annonçait.
  - IND-03 : ×16 risque de ne pas tenir 50 000 individus.
- **Interprétations.**
  - La grégarité comme trait de caractère acquis, tiré de la sous-espèce et rapproché de celui de la mère (`upbringing`, 0,3), et sa cohésion nomade de 0,5.
  - Le guide (C2, D4 ne dit pas qui choisit) : le meneur, sinon l'aîné.
  - Chacun garde sa place au camp suivant.
  - Les départs étalés sur cinq jours selon la grégarité.
  - Les étapes droites à vitesse constante, au coût moyen de l'étape.
  - Le retardataire qui presse le pas, de 1,25 fois.
  - L'écart de côté entre marcheurs, un jour sur deux.
  - Chacun immobile à sa place entre deux trajets, avant 2b.8.
  - Le lieu du groupe : la case du membre le plus proche du barycentre.
  - La stature de référence de 0,75 case, qui rend les gens trois fois plus petits à l'écran qu'aujourd'hui, et la courbe de croissance.
  - Une seule densité entière pour tous les individus d'une vue, et des variantes d'une rangée plutôt qu'une échelle continue, qui ferait des mixels.
  - Le seuil de la vue rapprochée à 8 pixels CSS.
  - L'appui qui ouvre la fiche de l'individu de près, et celle du groupe de loin ou entre ses membres.
  - Les nourrissons portés.
  - Les morts qui disparaissent sans trace.
  - La partie migrée de la version 6, qui ne rejoint plus son rejeu.
