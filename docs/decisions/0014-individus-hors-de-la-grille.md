# ADR 0014 — Individus hors de la grille

Statut : proposé · 18 novembre 2026 · tâche 2b.3. L'étape (a), simulation, worker, protocole et données, est réalisée ; l'étape (b), rendu des individus, interpolation, appui et révision des autres ADR, reste à faire. La critique de la conception a demandé des changements, qui priment sur elle : ce document dit ce qui est fait. Les écarts et interprétations de la dernière section sont à soumettre à l'auteur.

## Contexte

La consigne de 2b.3 fait foi (`docs/design/corrections-phase-2.md`) : chaque individu a une position continue, en cases et fractions de case ; sa taille et sa résolution d'affichage lui sont propres, converties en pixels au rendu selon le zoom, jamais contraintes à un multiple de la case ; même en groupe, chacun est une entité distincte, et les membres d'un groupe ne se rangent plus en grappe. Le sous-pas quotidien de 2b.2 ne recalcule que les positions et les activités des individus actifs (ADR 0013) ; 2b.8 tirera de l'activité un mouvement visible, pour les seuls visibles ; 2b.5 apportera les humains des planches et leurs versions réduites. Les tuiles ne changent pas.

L'auteur a tranché le 18 novembre, après une première conception rejetée : la position d'un individu est une variable de la simulation, et non du rendu ; la marche des groupes de 2b.2 n'a pas de sens dans ce jeu ; les mouvements sont individuels, grégaires en l'absence de ville ou de civilisation, et selon l'individu. La première conception faisait de la position une fonction pure calculée au rendu, et gardait les membres en file sur le chemin du groupe : tout ce qui en dépendait est abandonné. En sont repris, corrigés des défauts que sa critique y a mesurés, la stature tirée des données, la densité commune des individus d'une vue, le seuil des individus et l'appui.

Avant 2b.3, un groupe parcourait jour après jour le chemin que le pas mensuel avait noté (`state.walks`), et ses membres se dessinaient en spirale autour de lui (`clusterOffset`).

La conception s'appuyait sur un prototype hors du dépôt. Les mesures de ce document sont désormais celles de l'implémentation, prises dans ce conteneur de quatre cœurs par des scripts hors du dépôt, sauf mention du prototype ; elles portent sur deux scénarios :
- trois graines (`graine`, `autre`, `pixelciv`) de cent groupes de trente sur un monde Petit (le scénario de `src/sim/state.test.ts`), jusqu'à 120 mois ;
- 5 000 à 50 000 individus en groupes de 25, semés comme dans le banc d'essai sur un monde Immense (graine `banc-population`), six mois de mise en route puis douze mois mesurés.

## Décision

### 1. L'état

- **Position.** Deux colonnes des vivants, `x` et `y` (Int32), en 1/65 536 de case (virgule fixe 16.16, `src/core/position.ts`). La case (i, j) couvre [i, i + 1[ × [j, j + 1[, comme dans l'ADR 0013 ; x ∈ [0, largeur × 2^16[ et y ∈ [0, hauteur × 2^16[. La virgule fixe rend l'état exact et compact : la couture est un modulo entier, une étape avance d'une addition entière par jour, et sauvegarde, empreinte et messages copient des entiers. Les décisions (direction, durée d'une étape, place) se calculent en flottants, par les seules additions, soustractions, multiplications, divisions et racines carrées (`Math.sqrt`, jamais `Math.hypot`), puis s'arrondissent par `Math.round`. Aucune trigonométrie : une direction tirée au sort l'est par rejet dans le disque unité, à partir de deux tirages uniformes, et les seize directions des anneaux de secours se calculent par racines carrées ; `dmath` n'est donc pas requis. Toute abscisse revient dans [0, largeur × 2^16[ après chaque addition, et tout écart horizontal se prend au plus court, dans [−largeur × 2^15, largeur × 2^15[.
- **Mouvement propre**, dans les colonnes des vivants :
  - `move` (Uint8). Ses trois premiers bits disent l'intention : au repos, en partance, en marche, porté, ou « à poser », que seule produit la migration de la version 6 (§ 7). Cinq bits s'y ajoutent : `RETRY` et `SETTLE`, une place reprise à l'arrivée (§ 3) ; `DETOUR`, le détour par le champ de distances ; `LATE`, une marche commencée un mois précédent ; `JOIN`, un membre qui rejoint son groupe depuis un autre. Les huit bits sont pris ;
  - `depart` (Uint8), le jour du départ de qui est en partance ;
  - `goalX` et `goalY` (Int32), la place visée ;
  - l'étape en cours : `stepX` et `stepY` (Int32), le déplacement par jour, et `stepDays` (Uint16), les jours restants. La fin de l'étape vaut exactement la position plus `stepDays` pas.

  L'allure ne se stocke pas : elle se déduit de l'individu (§ 3). Avec la grégarité (§ 3), un vivant passe de 76 à 105 octets, et un mort de 67 à 68 ; 2b.8 ajoutera l'activité.
- **Groupe.** Il gagne `campX` et `campY`, la case du camp que choisit son guide (§ 3). `x` et `y` gardent leur sens, la case où se tient le groupe au pas mensuel ; elle se déduit désormais de ses membres.
- **Sauvegarde et empreinte.** Ces colonnes et ces champs y entrent tels quels : `fingerprintPeople` parcourt déjà toutes les colonnes. Les structures qui s'en déduisent sont des caches (`Movement`, `src/sim/movement.ts`), hors de la sauvegarde et de l'empreinte : liste des marcheurs, partants de chaque jour, grille des places tenues par case (gens au repos, places visées des marcheurs et des partants), nourrissons de chaque mère, guide et effectif de chaque groupe, champs de détour, disque franchissable autour d'un centre de camp, allure de chacun pour le mois. Ils se tiennent au fil des jours, et `rebuildMovement` les refait de l'état : au chargement, au plan de chaque mois, après chaque lot de commandes, et après toute exception d'un jour ou du pas mensuel. `describeMovement` les décrit pour les tests d'invariants.

### 2. Le sous-pas quotidien

- **Actifs.** Ce sont les marcheurs ; les nourrissons que portent les marcheuses prennent la position de leur mère. Les gens au repos ne coûtent rien, et ceux en partance attendent dans la liste de leur jour de départ, dressée au pas mensuel. La liste des marcheurs se tient sans parcourir les vivants : un départ y entre, une arrivée en sort. Chaque marcheur avance sans lire les autres : l'ordre de la liste ne change rien à l'état, et elle se reconstruit au chargement dans n'importe quel ordre. Les systèmes qui lisent les autres passent dans un ordre canonique.
- **Ordre fixe d'un jour** (`moveDay`, appelé par `advanceDay`) :
  1. les commandes, comme dans l'ADR 0013 ;
  2. les départs du jour, par emplacements croissants : chacun tire sa place (§ 3) ; un partant dont l'ancre part le même jour la fait partir d'abord ;
  3. (2b.8 : les activités) ;
  4. la marche : qui finit son étape calcule la suivante (§ 3), puis chacun avance d'une addition ; les portés suivent leur mère ;
  5. l'espacement, un jour sur trois (`walkers.every`), groupe par groupe (§ 3) ;
  6. les arrivées, par emplacements croissants (§ 3) ;
  7. le jour suivant, ou le pas mensuel au soir du trentième jour.
- **Tirages.** Un flux nouveau, `sim.camp`, sert aux places des apparitions, aux jours de départ, aux places tirées au départ et à celles reprises à l'arrivée ; la marche et l'espacement ne tirent rien. Un autre, `sim.temper`, tire la grégarité (§ 3). Aucun autre flux n'en est décalé : `sim.groups`, `sim.deaths`, `sim.couples`, `sim.births` et `sim.spawn` tirent autant qu'avant.
- **Coût mesuré.** Un marcheur en milieu d'étape coûte une addition. Le coût vient donc des trajets, et non des jours de marche. À 50 000 individus, un mois compte 78 000 étapes, dont 58 000 droites et 18 000 écarts de côté, 35 000 arrivées et 40 000 places tirées ; les pointes tombent les jours de départ.

  | Vivants | Marcheurs par jour, en moyenne | Un jour : moyenne, 95e centile, au plus | Pas mensuel, et image des groupes | Mois entier (30 jours et le pas) | 2b.2 : un jour, un mois entier |
  |---|---|---|---|---|---|
  | 2 300 à 2 700 (3 graines, mois 7 à 18) | 890 à 1 100 | 0,36 à 0,43 ms, 1,4 à 1,6 ms, 2,7 à 4,7 ms | 7,5 à 8,9 ms | 18 à 21 ms | 0,008 ms, 4,8 à 7,3 ms |
  | 5 000 | 2 400 | 0,80 ms, 3,0 ms, 9,7 ms | 15 ms et 2,9 ms | 38 ms | — |
  | 10 000 | 4 700 | 1,35 ms, 4,9 ms, 9,0 ms | 21 ms et 2,2 ms | 61 ms | — |
  | 20 000 | 9 700 | 3,4 ms, 13 ms, 24 ms | 49 ms et 3,3 ms | 148 ms | 0,06 ms, 39 ms (mesure du concepteur) |
  | 49 300 | 24 500 | 8,4 ms, 27 ms, 40 ms | 107 ms et 7,8 ms | 351 ms | 0,10 à 0,20 ms, 81 à 95 ms (mesure du concepteur) |

  Où va le temps du mouvement, au profil, à 50 000 individus : les places libres (tirages et recherche de la place tenue la plus proche) 25 %, le parcours des segments 25 %, l'espacement 12 %, la boucle de la marche 12 %, les départs 11 %, le plan du mois 8 %, l'allure 5 %.

### 3. Le mouvement

**Grégarité.** C'est un trait de caractère acquis (IND-07), et non un gène : IND-05 énumère les gènes, et IND-07 range les traits de caractère parmi les traits acquis, distincts d'eux. Elle n'occupe donc aucun des huit octets de traits du génome, que les mods gardent libres. C'est une colonne des vivants, `gregariousness` (Uint8, de 0 à 255), copiée dans l'archive pour la fiche. Elle se tire à la naissance et à l'apparition sur un flux propre, `sim.temper`, deux tirages uniformes par individu, si bien qu'elle ne décale aucun autre flux : sans le mouvement, la démographie des trois graines reste identique à celle de 2b.2 après 120 mois. Chaque sous-espèce en donne la répartition (`temperament.gregariousness` de `data/species.json`, moyenne 0,5 et écart type 0,2) ; un métis tire dans la moyenne de celles de son ascendance, et l'enfant tient en partie de sa mère, par l'éducation : sa grégarité vaut `upbringing` (0,3) × celle de sa mère, plus (1 − `upbringing`) × son tirage. Une sauvegarde qui ne la connaît pas donne à chacun la moyenne de son ascendance. La fiche la montre en niveau, comme les traits. Le contexte la module (`data/nomads.json`, `camp.cohesion`, 0,5) : la grégarité effective vaut g' = 1 − (1 − g) × (1 − c), si bien que, dans un groupe nomade, la personne la plus solitaire vaut encore 0,5. La phase 3 donnera aux villages leur propre cohésion, plus faible. En 2b.3, la grégarité règle la place au camp, le jour du départ et l'allure.

**Qui choisit le camp : trois modèles.**
- *(a) Un guide choisit le camp, et chacun s'y rend à sa façon.* Une seule évaluation par groupe et par mois : la fonction et les tirages de `moveGroup`, parce que la nourriture reste une affaire de groupe (C2, D4).
- *(b) Un conseil des adultes.* Chacun évaluerait ses propres cases, et le groupe suivrait la majorité. Cela ferait dix fois plus d'évaluations et de tirages, pour une même issue tant que l'économie reste celle du groupe. Si chacun suivait son propre choix, le groupe se disperserait sans se scinder.
- *(c) Un essaim sans but.* Cohésion, séparation et gradient local de nourriture : tout émergerait, mais rien ne garantirait le déplacement « au fil des saisons vers les meilleurs terrains de son aire ». Il faudrait juger la nourriture par individu et par jour, et chercher les voisins de chacun chaque jour.

Le modèle (a) est retenu : il tient D4 à son coût d'aujourd'hui et laisse la démographie dans le bruit (voir plus bas). Le choix du camp est collectif ; la place, le jour, l'allure et la route de chacun lui sont propres. Le guide est le meneur s'il vit dans le groupe, sinon l'aîné de ses membres qui ne sont pas portés ; le groupe garde le nom de son meneur (ADR 0011). Le guide évalue comme `moveGroup` en 2b.2 : les mêmes dix cases, tirées sur `sim.groups` autour du lieu du groupe, la même valeur, nourriture et aire, et le même budget. Le camp est la case qu'atteint `walk` dans ce budget, sans noter de chemin. Si le guide reste, le camp ne change pas, et personne ne part. Le camp d'un groupe né d'une scission est la case qu'atteint `walk` vers sa nouvelle aire ; il ne bouge plus de ce pas mensuel. Le guide ne lève pas non plus le camp tant qu'un membre venu d'un autre groupe, ce mois-ci ou en marche depuis, se tient à plus de deux cases du camp (`camp.wait`) : le groupe l'attend.

**Chacun s'y rend.**
- *Sa place.* Il la tire le jour de son départ, et non plus au pas mensuel ni d'après sa place au camp précédent, autour de l'ancre de son foyer (`anchorOf`) :
  - le guide, autour du centre du camp, dans un rayon de 0,3 case (`camp.guide`) ;
  - le chef de foyer, autour du guide : c'est, d'un couple, celui des deux dont l'identifiant est le plus petit, ou qui, sans conjoint, n'a dans le groupe ni sa mère ni, s'il est mineur, son père. Le rayon vaut (0,8 + 5 × (1 − g')) × max(1, 0,18 × √n) cases pour un groupe de n membres (`camp.band`, `camp.spread`) : 1,05 case pour g' = 0,95, et 3,3 cases pour g' = 0,5 ;
  - les autres, autour de leur ancre : le conjoint chef de foyer, sinon la mère, sinon, pour un mineur, le père. Le rayon vaut 0,6 + 1,2 × (1 − g') cases (`camp.kin`), de 0,66 à 1,2 case.

  L'ancre est sa place visée si elle marche, sa position sinon ; elle part toujours le même jour que lui, ou avant. La place doit être sur une case franchissable, en vue du centre du camp (segment libre, sauf dans le disque franchissable autour du centre, qui le garantit) et à 0,45 case au moins de toute place tenue (`camp.gap`), hors de celles des partants, qui les libèrent. Seize tirages au plus, par rejet dans le disque : six dans le rayon, six dans un rayon 1,6 fois plus grand, quatre dans un rayon 2,5 fois plus grand. À défaut, six anneaux de seize points autour de l'ancre, de 0,225 en 0,225 case, sans tirage ; à défaut encore, la place la plus éloignée des autres parmi celles qui sont en vue, puis l'ancre, puis le centre du camp. Mesuré : 1,2 à 1,3 % des arrivées trouvent leur place prise, et en tirent une autre ; 0,2 % se posent faute de mieux trop près d'un autre.
- *Son jour.* Le guide part le jour 0, comme qui rejoint un autre groupe et qui marchait encore au pas mensuel ; les autres, le jour ⌊20 × (1 − g') × u⌋, où u est tiré au sort (`camp.lag`), et jamais avant leur ancre. Un nourrisson porté part avec sa mère.
- *Sa route, par étapes droites.* Il vise sa place en ligne droite si la voie est libre. Les cases que traverse le segment se cherchent avec la règle du coin, et la couture : passer à moins de 2^-16 case d'un coin, c'est passer en diagonale, ce qui demande que les deux cases qu'il enjambe se franchissent. Le coût de chaque case se compte au prorata du chemin qu'il y fait. Sur l'étape, sa vitesse est constante : son allure divisée par le coût moyen de l'étape, au moins 1. Le pas, entier, s'arrondit : le segment se vérifie alors entre les extrémités entières de l'étape, le départ et le départ plus n pas, sauf si cette fin reste dans la case du but et que le segment ne frôle aucun coin de plus près que l'écart. Si la ligne bute, il marche jusqu'au bord, si cela le rapproche d'une case ; sinon il passe, par son centre, à la case voisine qui le rapproche le plus, selon la règle de `walk` ; et si aucune ne le rapproche, il descend le champ de distances du camp de son groupe. Ce champ est un Dijkstra exact, borné à une boîte fixe de 48 cases autour du camp (`camp.field`), calculé à la première demande du mois et jamais prolongé ; il se vide à chaque plan du mois et à chaque coup de pinceau, si bien qu'il est le même après un chargement. Chaque changement de case rapproche strictement de la place, ou descend strictement le champ : il n'y a pas de cycle. Qui n'a plus de chemin se pose là où il est ; ce n'est arrivé dans aucune mesure. Mesuré à 50 000 individus : des étapes vers une place, 97 % vont en ligne droite ; chaque mois, quelque 220 étapes descendent un champ, et 22 champs se calculent.
- *Son allure*, en cases de plaine par jour (`ownPace`) : nomads.walk / 30 × (0,8 + 0,4 × l'endurance de son ascendance), comme le budget de marche d'un groupe ; fois sa rapidité, de 0,85 à 1,15 selon le trait de rôle `speed` (IND-05, jusqu'ici sans emploi) ; fois le facteur de son âge (`pace.age` de `data/species.json`, de 0,5 à la naissance à 1 de 15 à 50 ans, puis 0,6 à 95 ans) ; fois 0,9 s'il porte un nourrisson et 0,9 si elle est enceinte (`pace.carrying`, `pace.pregnant`). Elle se rapproche de celle du guide selon sa grégarité : a = g' × a_guide + (1 − g') × a_propre. Qui marche encore au pas mensuel presse le pas (`camp.hurry`, 1,25). Mesuré : de 18 à 45 ans, 0,95 à 1,1 case par jour en médiane sur la steppe, et moitié moins sur un terrain de coût 2.
- *Ses trajets.* 14 ou 15 jours en médiane, de 44 à 48 jours au 95e centile, de 57 à 73 au 99e ; l'arrivée tombe vers le 16e ou le 17e jour du mois. Qui marche encore au pas mensuel garde sa place si le camp n'a pas changé ; sinon, il en tire une au nouveau camp, dès le jour 0.
- *Le terrain.* Les coûts sont ceux de la marche de 2b.2 (`state.cost`). Un individu ne se tient jamais sur une case infranchissable, n'en traverse jamais, et ne coupe jamais un coin, couture comprise. Le segment de chaque jour est droit et vérifié : le rendu, qui interpolera sur ce segment d'un jour à l'autre, ne coupera pas l'eau.

**Ce qui se voit de la grégarité**, mesuré sur les trois graines, mois 3 à 39, en classes de g' : moins de 0,7 (trait sous 0,4) et 0,8 ou plus (trait de 0,6 ou plus).

| | Peu grégaire (g' < 0,7) | Très grégaire (g' ≥ 0,8) |
|---|---|---|
| Jour de départ, hors guides : moyenne, 9e décile | 3,1 à 3,2, jour 6 | 1,4 à 1,5, jour 3 |
| Écart au barycentre de son groupe, au repos : médiane (quartiles) | 1,39 à 1,43 case (0,9 à 1,9) | 1,09 à 1,11 case (0,7 à 1,5) |
| Jours de marche seul, sans personne de son groupe à moins d'une case | 14 à 15 % | 5 à 6 % |

Le jour de départ va jusqu'au 9e dans les deux classes : un enfant grégaire ne part pas avant sa mère. Entre deux trajets, chacun se tient à sa place, faute d'activités (2b.8).

**La formation brisée.** Les quatre indicateurs de la critique, recalculés sur l'implémentation selon ses définitions (trois graines, mois 3 à 39) :

| Indicateur | Prototype, places gardées | Implémentation |
|---|---|---|
| Écart de la direction de chaque marcheur à la direction moyenne de son groupe : médiane (3e quartile) | 3,2 à 3,5° (7 à 8°) | 6,9 à 7,2° (13°) |
| Groupe-jours où tous les marcheurs ont la même allure | 94 à 96 % | 0 à 0,1 % |
| Marcheurs à moins de 0,05 case par jour du déplacement médian de leur groupe | 64 à 65 % | 40 à 42 % |
| Corrélation des écarts au barycentre d'un camp au suivant, à plus de trois cases (médiane) | 0,61 à 0,65 | 0,02 |

**Espacement.**
- *Au repos.* Les places sont tenues dès le départ, et vérifiées à l'arrivée, par emplacements croissants : qui trouve une place tenue à moins de 0,45 case de la sienne en tire une autre autour d'elle, dans un rayon de 1,2 case élargi au besoin, et s'y rend ; au second refus, il se pose quoi qu'il trouve. Les grilles sont par case : une requête n'y visite que quelques cases, sans coût quadratique. Mesuré sur treize mois : de 0,5 à 2,2 % des gens au repos sont à moins de 0,45 case d'un autre, et de 0 à 0,85 % à moins de 0,2 (le haut de ces fourchettes vient d'une graine dont des îles serrent les camps). Les places viennent de tirages dans des disques : aucune spirale, aucun motif.
- *En marche*, un jour sur trois (`walkers.every`), groupe par groupe. Les marcheurs d'un groupe se rangent par abscisse, déroulée depuis le premier d'entre eux, et ne se comparent qu'à ceux qui en sont à moins de 0,25 case (`walkers.gap`). Le second d'une paire, par emplacements, qui serait encore trop près le lendemain à leurs pas du jour, s'écarte de son plus proche voisin, perpendiculairement à son pas, de 0,3 case au plus (`walkers.aside`), si le segment du jour, depuis sa position de la veille, reste libre ; il recalcule son étape le lendemain. Deux marcheurs qui se croisent s'éloignent d'eux-mêmes, et ne s'écartent pas ; deux groupes ne font que se croiser. Tous décident d'après les positions du jour, puis s'écartent ensemble. Mesuré : 3,3 à 3,4 % des marcheurs à moins de 0,15 case d'un autre, 6,3 à 6,6 % à moins de 0,2 ; 0,39 à 0,43 % des jours de marche passés à moins de 0,2 case d'un même voisin trois jours de suite ou plus. Sans places tenues ni espacement, le concepteur mesurait 8,5 % sous 0,15 case. Un jour sur deux donnait 2,6 à 2,8 % et 0,18 à 0,26 %, pour 1,5 à 2,5 ms de plus par jour à 50 000 individus.

**Naissances, morts, changements de groupe.**
- *Naissance.* Le nourrisson paraît à la position de sa mère, porté, sans tirage. Il le reste jusqu'à l'âge `ages.baby`, tant que sa mère vit dans son groupe : il prend sa position, ne compte pas dans l'espacement, et se dessinera contre elle (§ 6), du côté que donne son identifiant (`carriedSide`), sans changer quand un frère naît ou est sevré. Au sevrage, au plan du mois, il part de cette position dessinée, à 0,2 case de sa mère (`display.carry`) : si elle reste au repos, il gagne en une étape d'un jour, le jour 0, sa place à 0,3 case d'elle, du même côté (`camp.wean`) ; si elle part ou marche, il part avec elle vers une place près d'elle. Orphelin, sa mère morte ou partie, il se pose là où elle se tenait, et part avec son groupe.
- *Mort.* Le mort disparaît là où il se tenait, au pas mensuel ; personne ne bouge, et sa place se libère.
- *Changement de groupe.* Qui change de groupe reste où il est au pas mensuel, puis part le jour 0 vers une place au camp de son nouveau groupe, avec les nourrissons qu'il porte. Cela vaut pour tous les membres d'une réunion, pour le conjoint d'un mariage et pour les partants d'une scission. Le pas mensuel relève, à son début, l'identifiant et le groupe de chaque emplacement, dans un tableau qui ne sert que le temps du pas : le plan du mois y voit qui a changé de groupe, sans rien garder dans l'état, et un emplacement repris par une naissance ne compte pas comme un changement. Le transféré vise le camp de son nouveau groupe, que le guide n'éloigne plus tant qu'il est à plus de deux cases : il marche de 25 à 27 jours en médiane, de 37 à 46 au 9e décile, de 62 à 72 au 99e centile, 99 au plus, et plus d'un mois une fois sur trois (mesuré sur 964 à 1 191 transferts par graine en 40 mois). Le prototype, sans attente, allait jusqu'à 80 à 108 jours au 99e centile, 117 au plus : l'attente ne raccourcit que la queue, car le voisinage admet un mois de marche, et plus avec les détours. Pendant sa marche, le transféré se nourrit de loin : l'économie reste celle du groupe, qui le compte parmi ses membres. Rien ne saute.

**Lieu du groupe et pas mensuel.**
- *Le lieu.* C'est la case du membre le plus proche du barycentre de ses membres qui marchent (portés exclus, `centralMember`). Les écarts se prennent au plus court, par rapport au premier membre dans l'ordre des emplacements ; à égalité, le premier l'emporte. Ce lieu est toujours franchissable. Il se calcule au début du pas mensuel, avant la repousse : nourriture, aire, climat du cycle de vie, voisinage, réunions, scissions et chronique le lisent. La fiche applique la même règle, à la demande, aux positions du jour. L'économie ne change pas : stocks du groupe, pris dans un disque autour de son lieu.
- *L'ordre* (`monthStep`) : relevé des groupes, lieu des groupes (sans tirage), repousse, cueillette, cycle de vie (le nouveau-né paraît à la position de sa mère), réunions, scissions (le camp du nouveau groupe), camps (`moveGroup`, sans chemin noté, ni pour les groupes nés d'une scission du mois ni pour ceux qui attendent), puis le plan du mois (`planMonth`, sur `sim.camp`) : qui part, les sevrages, et les jours de départ. Les places se tirent aux départs.
- *La démographie après 120 mois*, en vivants et en groupes :

  | Graine | 2b.2, et 2b.2 avec la grégarité | Prototype | Implémentation | Implémentation sans attente |
  |---|---|---|---|---|
  | `graine` | 2 383, 170 | 2 358, 161 | 2 345, 164 | 2 456, 164 |
  | `autre` | 2 682, 175 | 2 767, 187 | 2 754, 176 | 2 790, 183 |
  | `pixelciv` | 2 921, 186 | 2 987, 188 | 3 026, 193 | 3 062, 194 |

  Les vivants varient de −1,6 à +3,6 % et les groupes de −3,5 à +3,8 %, comme ceux du prototype (−1,0 à +3,2 %, −5 à +7 %). La règle d'attente coûte de 1,2 à 4,5 % des vivants sur les trois graines : le groupe qui attend ne gagne pas un meilleur camp.

### 4. Ce que devient la marche des groupes de 2b.2

- **Retiré** à l'étape (a) :
  - `state.walks` et `src/sim/walks.ts` : `Walks`, `WalkRecorder` et `DayPositions`, ainsi que `rebuildPositions` ;
  - `src/core/walk.ts`, `walkPosition` compris : seule la migration de la sauvegarde 6 relit encore les marches, en interne (`src/sim/save.ts`) ;
  - le paramètre `record` de `walk`, et la marche que notaient `moveGroup` et `splitGroup` ;
  - les cinq tableaux de marches de la sauvegarde 6, qui ne se lisent plus qu'à sa migration, et leur part de l'empreinte ;
  - les marches de l'image des groupes du protocole 5 ;
  - dans `src/app/frames.ts`, `walkOf` et `walkDay` ;
  - le nombre de marches en cours de `StepStats`, qui devient le nombre de marcheurs.
- **Reste, pour l'étape (b).** Le fil principal minimal de l'étape (a) dessine chaque membre à la position que donne l'image des groupes, sans interpoler les étapes : jusqu'à l'étape (b), chacun saute d'une image à la suivante, au pas mensuel. Les bannières se posent au barycentre de ces positions (`groupPositions`). `clusterOffset`, `clusterReach` et `memberBox` (`src/render/crowd.ts`) servent encore à ce rendu provisoire, et partiront avec lui.
- **Remplacé.** La marche d'un groupe devient le trajet de chacun (§ 3), et la position du groupe, celle de ses membres. Les garanties de l'ADR 0013 tiennent :
  - l'état ne dépend ni de la vitesse ni du regroupement des jours, puisque le jour reste l'unité et que ses systèmes sont indépendants de l'ordre, ou passent dans un ordre canonique ;
  - une commande s'applique au début du jour suivant ;
  - le rejeu se fait jour par jour ;
  - le pas mensuel tombe au soir du trentième jour ;
  - le rendu interpolera entre deux jours, sur les segments vérifiés de chaque jour.

### 5. Protocole 6

Réalisé du côté du worker ; le fil principal minimal de l'étape (a) le lit sans interpoler.

- **Tous les individus, par leurs étapes.** Le worker n'envoie pas une position par jour et par marcheur, mais chaque étape quand elle commence ; le fil principal en tirera exactement les mêmes positions que le worker, par les mêmes additions entières. Une étape tient en 26 octets (`LegArrays`) : l'emplacement (Uint32), le jour où elle part (Uint32, `dayIndex`), le point de départ et le pas (Int32 × 2 chacun), et le nombre de jours (Uint16). À l'instant t, fractionnaire, le marcheur se tient en départ + pas × min(max(t − jour, 0), jours), x ramené dans le monde (`legAt`) : aux jours entiers, c'est la position exacte du worker. Pour un emplacement, l'étape qui vaut est la dernière reçue de celles qui sont parties ; une étape du même jour remplace la précédente : c'est un écart de côté, une étape d'un jour partie de la position de la veille. Rien n'est quantifié : point et pas sont les entiers 16.16 de l'état ; l'emplacement désigne l'individu, et l'image des groupes le relie à son identifiant. Il n'y faut aucun message pour une arrivée, qui est la fin d'une étape. Les autres solutions sont écartées :
  - les positions quotidiennes de tous les marcheurs : 12 octets par marcheur et par jour, 290 Kio par jour à 50 000 individus ;
  - les seuls individus de la vue, que le fil principal signalerait au worker : il faudrait renvoyer la vue à chaque déplacement, recevoir des instantanés de région, et accepter des individus qui paraissent en retard au panoramique rapide.
- **L'image des groupes**, quand elle change : au pas mensuel, et après une commande qui change les groupes. Elle garde ses cinq valeurs par groupe (`GROUP_STRIDE`) : identifiant, lieu, membres, culture. Elle porte, membre par membre, groupe après groupe, l'emplacement (Uint32), l'identifiant (Uint32), le code d'apparence (Uint16), la stature (Uint8, en 1/128 de case, § 6), la position (Int32 × 2) et l'emplacement de qui le porte (Uint32, `NO_CARRIER` s'il marche) : 23 octets. S'y ajoute l'étape en cours de chaque marcheur, repartie de l'instant de l'image. Mesuré : 59 à 64 Kio à 3 000 individus (2 400 à 2 700 vivants), 453 Kio à 20 000, 1 124 Kio à 48 000 ; au pas mensuel, quelques dizaines de membres marchent encore.
- **Le delta de chaque lot** porte, en plus du temps, des blocs et des faits, les étapes commencées pendant ses jours, chacune datée de son jour : à ×16, un lot de trois jours apporte celles de ses trois jours. Mesuré : 96 à 112 étapes par jour à 3 000 individus, soit 2,4 à 2,8 Kio (14 à 16 Kio au plus, un jour de départs) ; 1 030 à 20 000 individus, 26 Kio (116 au plus) ; 2 590 à 48 000, 66 Kio (297 au plus). À ×16, un mois toutes les 208 ms, images et étapes font 0,6 à 0,7 Mio/s à 3 000 individus, 5,8 Mio/s à 20 000 et 14,6 Mio/s à 48 000, transférés et non copiés.
- **Tampons.** Image et étapes voyagent en tableaux typés transférés. Le fil principal rend les tampons lus (message `recycle`) : ceux d'une image quand la file des images la lâche, ceux des étapes dès qu'il les a lus. Le worker les garde par classes de taille, des puissances de deux (`BufferPool`, `src/core/buffers.ts`), et en reprend un pour un tableau jusqu'à quatre fois plus petit, dans la limite de 96 tampons et de 64 Mio.
- **Mesures du lot.** `StepStats` donne les marcheurs à la fin du lot et les étapes commencées pendant lui.
- **Fil principal (étape b).** Il tiendra, par emplacement, la position de l'image de l'instant affiché et l'étape en cours. Les étapes reçues attendront leur jour dans une file datée, comme les images (`FrameQueue`). À l'instant t affiché, la position vaudra `legAt`. L'interpolation entre deux jours suivra donc l'étape, qui ne coupe pas l'eau. En pause, l'instant s'arrête, et tout aussi. Changer de vitesse ne change rien aux étapes. Au panoramique rapide, tout est déjà connu.
- **Bannières (étape b).** Chaque bannière se posera au barycentre des membres de son groupe, à l'instant affiché, écarts pris au plus court ; si ce point tombe sur l'eau, elle se posera au membre le plus proche. Le fil principal le calculera, en vue lointaine seulement.

### 6. Taille, résolution et rendu

La stature se calcule dans le worker et part dans l'image des groupes ; le reste de cette section est à réaliser à l'étape (b).

- **Stature.** C'est la hauteur de l'individu debout, en cases : la stature de référence de son espèce, celle d'un adulte de taille moyenne (`display.stature` de `data/species.json`, 0,75 case) ; fois sa croissance (`display.growth`, part de la stature adulte selon l'âge, linéaire par morceaux) ; fois sa taille (trait de rôle `height`) sur la taille moyenne de l'espèce. Le worker l'envoie en 1/128 de case. Le schéma exige qu'elle tienne sur un octet : stature × croissance maximale × 2 × height[1] / (height[0] + height[1]) ≤ 255/128.
- **Résolution et conversion.** Chaque motif a sa grille de pixels : aujourd'hui, le mini-sprite, de 9 rangées pour l'adulte, 7 pour l'enfant et 6 pour le nourrisson. À l'échelle s (`displayScale`), une case fait 4s pixels physiques, et l'adulte de référence vise 0,75 × 4s pixels. La vue prend un entier k ≥ 1, le même pour tous ses individus, arrondi de cette cible sur 9. Chaque individu se dessine en r × k pixels physiques de haut, où r est le nombre de rangées de sa variante, au plus proche, les pieds sur sa position arrondie au pixel physique. La variante se choisit sur la cible non arrondie, r = arrondi(stature / stature de référence × 9), dans les variantes de sa classe d'âge : 8 à 10 rangées pour l'adulte, 6 à 8 pour l'enfant, 6 pour le nourrisson. Elle ne dépend donc ni de k ni du zoom : c'était le défaut de la première conception. Les variantes s'obtiennent en doublant ou en ôtant une rangée désignée de la source. La taille propre se voit surtout à la croissance des enfants, et aux extrêmes : une rangée de plus ou de moins ne distingue qu'un adulte sur cinq environ, comme l'a mesuré la critique de la première conception. Ni la taille ni la position ne s'alignent sur la case.

  Hauteur d'un adulte de taille moyenne, en pixels CSS (avec k) :

  | Zoom | 3 | 4 | 8 | 16 | 24 |
  |---|---|---|---|---|---|
  | Aujourd'hui | 27 | 36 | 72 | 144 | 216 |
  | Densité 1 | 9 (k = 1) | 9 (1) | 27 (3) | 45 (5) | 72 (8) |
  | Pixel 5 (densité 2,75) | 9,8 (3) | 13,1 (4) | 22,9 (7) | 49,1 (15) | 72 (22) |

- **Une densité par vue.** Les écarts à REN-04 et REN-08 sont déjà décidés par l'auteur pour 2b.3 (`docs/BACKLOG.md`, écarts au PRD décidés). Interprétation proposée : les tuiles et les bannières gardent la densité de la carte, et tous les individus d'une vue partagent la leur, k, plus fine dès l'échelle 3 ; deux densités ne se mêlent jamais dans un même dessin, ni d'un individu à l'autre. Le décor et le gibier de 2b.6 prendront la densité des individus.
- **2b.5.** Les humains des planches et leurs versions réduites entreront comme niveaux de motifs, déclarés avec l'atlas. La vue prend le plus fin dont k reste à 25 % de la cible, sinon le plus proche ; ses variantes de hauteur seront à 2b.5 de les fixer, trois au plus.
- **Niveaux de détail.** De loin, la bannière de chaque groupe, inchangée (ADR 0010). De près, chaque individu, dès que l'adulte de référence vise 8 pixels CSS : à partir du zoom 3 à la densité 1, comme aujourd'hui, et du zoom 2,9 sur Pixel 5, si bien que le zoom 3 d'ouverture du téléphone montre les individus. Le nourrisson porté se dessine contre sa mère, à 0,2 case d'elle (`display.carry`), du côté que donne son identifiant (`carriedSide`), celui où il se pose au sevrage. Le marcheur alterne ses deux images de marche à une cadence propre au rendu, une alternance toutes les 200 à 420 ms au plus, déphasée par l'identifiant ; l'image reste figée en pause et hors d'une étape (changement requis par la critique : une cadence réglée sur les jours scintillerait à ×16).
- **Tri.** Le plus bas à l'écran passe devant, d'après les pieds, puis le dernier dessiné (`depth`) ; le porté passe juste devant sa mère.
- **Appui.** On touche ce qu'on voit. La tolérance vaut 4 pixels CSS pour un pointeur fin et 12 pour le doigt. Un individu touché, ou frôlé, ouvre sa fiche (IHM-02), d'où l'on gagne celle de son groupe ; à égalité, celui de devant l'emporte. Faute d'individu, un appui dans la boîte des membres d'un groupe, marge comprise, ouvre la fiche du groupe ; sinon, la case. Sur Pixel 5 au zoom 3, un adulte dessiné fait 9,8 × 6,5 pixels CSS, et sa cible au doigt 34 × 31. L'outil d'apparition refuse une case où se tient quelqu'un.
- **Coût.** Le pire cas tombe au seuil de la vue rapprochée. Sur un écran de 1 920 × 1 080 tout en terres, à la densité de 50 000 habitants sur un monde Grand, quelque 4 000 individus sont visibles, et 12 000 dans une région trois fois plus peuplée ; sur Pixel 5, 700 à 2 000. Les sprites et leurs textures recolorées se réutilisent. Ce conteneur rend en logiciel (SwiftShader) : les images par seconde n'y disent rien du GPU. L'étape (b) mesurera donc, au panneau de débogage, le temps du fil principal par image pour les positions, le tri et la mise à jour des sprites (cibles : 4 ms au plus avec 12 000 individus sur PC, 8 ms au plus avec 2 000 sur Pixel 5 ralenti ×4), ainsi que les textures distinctes et les appels de dessin par image, et décidera l'atlas dynamique sur ces mesures. Les images par seconde sur un vrai PC et un vrai téléphone sont à demander à l'auteur.

### 7. Sauvegardes, rejeu et empreintes

- **Version 7.** Les colonnes de position et de mouvement entrent dans celles des vivants, la grégarité dans celles des vivants et des morts, et `campX` et `campY` dans les groupes. La relecture vérifie, sans juger la franchissabilité, qui suit un contenu qui a pu changer (ADR 0007) :
  - les positions et les places visées dans le monde ;
  - une intention connue, et un jour de départ de 0 à 29 ;
  - une étape lisible : 1 000 jours au plus (`MAX_LEG_DAYS`), un pas de 4 cases par jour au plus (`MAX_STEP`), et une fin dans le monde ;
  - pour un porté, une mère vivante du même groupe ;
  - les camps dans le monde.
- **Migration de la version 6.** Elle calcule, d'après les marches de la sauvegarde, la position du jour de chaque groupe, toujours franchissable puisque les chemins de 2b.2 ne coupent aucun coin. Elle y pose chaque membre, « à poser » (`PLACE`), une intention que seule la relecture résout (`placeMigrated`) : le nourrisson dont la mère vit dans son groupe est porté ; les autres partent le jour même vers une place au camp de leur groupe, qu'ils tirent à leur départ. Le camp est la case du groupe au bout de sa marche de 2b.2, et le lieu du groupe, la case de sa position du jour. La grégarité, inconnue, prend la moyenne de l'ascendance. Les tableaux de marches sont ensuite oubliés. Les membres d'une partie migrée se tiennent donc au même point jusqu'à la fin du jour où elle reprend. Une partie migrée continue de façon déterministe, mais ne rejoint plus son rejeu : le journal, rejoué par les règles de 2b.3, ne redonne pas l'histoire faite par celles de 2b.2.
- **Rejeu.** Il ne change pas : jour par jour, jusqu'à un instant.
- **Empreintes.** Vérifié à la base (1eb5244) : les trois références de `src/sim/state.test.ts` redonnaient 91fb9419, 24f9fb6b et 8049a7e6.
  - Avec la seule grégarité, elles deviennent 107b7392, ff30d063 et f1ddca1e : la structure change (une colonne chez les vivants et dans l'archive, un flux), le déroulement non.
  - Avec le mouvement, elles deviennent f363d517, 8c0c534a et b4e23dbf. Pour l'an sans population, seule la structure change : les marches quittent l'empreinte, les colonnes de mouvement et les camps y entrent. Pour les deux autres, le déroulement change aussi : le lieu des groupes se déduit des membres, et `sim.camp` tire places et départs.

  Celles du banc d'essai sont à remesurer avec lui.

### 8. Les branchements à venir

- **2b.8.** Une colonne `activity`, fixée chaque jour par un système qui tourne avant la marche, sur son propre flux (`sim.activities`). L'activité règle l'intention : « suivi du groupe » met en partance quand le camp change, « repos au camp » laisse au repos. Cueillette, chasse, pêche, corvée d'eau et jeu gardent la place comme ancre de l'état. Leur mouvement visible est une animation déterministe tirée de l'activité, de l'identifiant, du jour et de l'ancre, que le rendu calcule pour les seuls visibles, sur le segment qui va de l'ancre à une cible que le worker vérifie et note dans l'état : seul le worker contrôle l'eau et les coins. Seuls les effets, comme une prise de chasse, sont un état, calculé dans le worker. Il reviendra à 2b.8 de décider si l'activité se tire pour tous chaque jour (de l'ordre de 1 ms à 50 000 individus) ou se déduit de l'état.
- **Phase 3.** Les villages auront leur cohésion, plus faible : chacun s'y déplacera pour son compte, sa maison comme ancre, et ses champs comme buts ou comme activités. Les temps de trajet en jours (« trois semaines de marche », C2, D13) se liront sur les mêmes coûts et les mêmes champs de distances, ceux des territoires (D14). Seuls les groupes nomades garderont un guide et un camp.

## Conséquences

- **Ce qui ne saute plus.** Réunions, mariages, scissions, naissances, sevrages et morts se font à pied, ou sur place ; chacun est une entité distincte.
- **Budget.** Comme l'a demandé la critique, le banc d'essai (`tools/population.bench.ts`) mesure, à 50 000 individus, le mois entier (30 jours et pas mensuel, au plus 208 ms, la durée d'un mois à ×16), le pas mensuel avec l'image des groupes (au plus 97 ms) et le jour le plus long (au plus 20 ms). L'implémentation ne tient pas ce budget dans ce conteneur : 351 ms, 115 ms et 40 ms. ×16 y tourne à 59 % de sa vitesse à 50 000 individus ; il tient jusqu'à 29 000 environ (148 ms à 20 000). En 2b.2, le mois entier prenait 81 à 95 ms à 48 000 individus, presque tout au pas mensuel : celui-ci prend désormais 107 ms, et les jours 244 ms par mois. Le banc échouera donc sur une machine comparable, tant que le budget n'est pas tenu ou revu.
- **Parades.** Sur les quatre que demandait la critique, deux sont faites telles quelles : les places se tirent au jour du départ, et les caches sont des tableaux typés. Les deux autres le sont autrement. Le contrôle de couloir par groupe devient un disque franchissable autour de chaque centre de camp, où les places se passent de segment, et le second parcours d'une étape s'évite quand sa fin entière ne change pas de case. Les listes de marcheurs par case deviennent un balayage par groupe, un jour sur trois, qui ne retient que les paires qui dureraient. De 50 000 individus, le mois entier est passé de 591 ms, à la première version, à 351 ms.
- **Téléphone** (processeur quatre fois plus lent, estimé d'après ces mesures) : ×16 tient jusqu'à 8 000 individus environ (le mois entier en 52 ms ici), contre 20 000 au moins en 2b.2 ; ×4, jusqu'à 29 000 environ. À soumettre à l'auteur, avec IND-03.
- **Mémoire et volume.** 29 octets de plus par vivant, et un par mort. Messages à ×16 : 14,6 Mio/s à 48 000 individus, images et étapes comprises, avec des pointes de 297 Kio d'étapes un jour de départs.
- **Génome.** La grégarité, trait acquis, n'y prend aucune place : le génome garde son huitième octet de trait libre. Le trait de rapidité (IND-05), jusqu'ici sans emploi, reçoit le rôle `speed`, qui règle l'allure (§ 3).
- **Révisions.** À l'étape (b), les ADR 0003 (empreinte), 0004 (protocole 6), 0007 (sauvegarde 7), 0010 (individus et appui), 0011 (positions, image des groupes, grégarité) et 0013 (marche des groupes retirée, seuils du banc) seront révisés, avec l'index et `docs/BACKLOG.md`.

## Écarts et interprétations à soumettre à l'auteur

- **Écarts.**
  - REN-04 et REN-08 : déjà décidés par l'auteur pour 2b.3 ; seule l'interprétation d'une densité commune à tous les individus d'une vue est à lui soumettre.
  - ADR 0013 : la position par individu est un état du worker. Son seuil de 0,5 ms par jour cède. L'image des groupes porte les positions et les étapes, et non l'identifiant de chaque membre et la case d'origine des transferts qu'il annonçait.
  - IND-03 : ×16 ne tient pas 50 000 individus dans ce conteneur, ni 10 000 sur un téléphone estimé ; le budget de la critique n'est pas tenu.
  - La critique demandait de soumettre les mesures du mouvement à l'auteur, avec une capture animée d'un groupe en marche au zoom 8, avant l'étape (a) : le déroulement de la tâche ne le permettait pas. Les mesures sont ici ; la capture viendra avec le rendu de l'étape (b).
- **Interprétations.**
  - La grégarité comme trait de caractère acquis, tiré de la sous-espèce et rapproché de celle de la mère (`upbringing`, 0,3), et sa cohésion nomade de 0,5.
  - Le guide (C2, D4 ne dit pas qui choisit) : le meneur, sinon l'aîné.
  - Les places tirées au départ autour de l'ancre du foyer (guide, chef de foyer, conjoint, mère, père), dans des rayons qui croissent quand la grégarité baisse ; le chef de foyer, d'un couple, est celui des deux dont l'identifiant est le plus petit.
  - Les départs étalés sur dix jours au plus, selon la grégarité, et jamais avant l'ancre.
  - L'allure propre, et rapprochée de celle du guide selon la grégarité ; le retardataire qui presse le pas, de 1,25 fois.
  - Les étapes droites à vitesse constante, au coût moyen de l'étape ; le champ de détour borné à une boîte fixe de 48 cases autour du camp.
  - L'écart de côté entre marcheurs d'un même groupe, un jour sur trois, pour les seules paires qui dureraient.
  - La règle d'attente : le guide ne lève pas le camp tant qu'un transféré est à plus de deux cases ; le transféré se nourrit de loin.
  - Chacun immobile à sa place entre deux trajets, avant 2b.8.
  - Le lieu du groupe : la case du membre le plus proche du barycentre.
  - La stature de référence de 0,75 case, qui rend les gens trois fois plus petits à l'écran qu'aujourd'hui, et la courbe de croissance.
  - Une seule densité entière pour tous les individus d'une vue, et des variantes d'une rangée plutôt qu'une échelle continue, qui ferait des mixels.
  - Le seuil de la vue rapprochée à 8 pixels CSS.
  - L'appui qui ouvre la fiche de l'individu de près, et celle du groupe de loin ou entre ses membres.
  - Les nourrissons portés, et leur sevrage par une étape d'un jour ; l'orphelin qui se pose là où se tenait sa mère, sans être porté par un autre.
  - Les morts qui disparaissent sans trace.
  - La partie migrée de la version 6, dont les membres partent d'un même point et qui ne rejoint plus son rejeu.
