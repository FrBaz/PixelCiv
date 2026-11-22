# ADR 0022 — Gestes des activités

Statut : accepté · 22 novembre 2026 · tâche 2b.8, réalisé au second temps de la tâche (le rendu, commits fc5bf5b à la documentation), avec l'ADR 0021 (les activités dans la simulation). Proposé le 21 novembre 2026 à la conception, sur un prototype et des captures hors du dépôt (dossier de conception de 2b.8), puis repris après sa critique : le § 9 dit ce qui est fait, et l'emporte sur le texte d'origine où il s'en écarte. Chromium rend ici en logiciel (SwiftShader) : ses temps de GPU et ses images par seconde ne disent rien d'un vrai appareil. La dernière section liste ce que l'auteur doit trancher ; la tâche a été réalisée sans attendre sa réponse, sur l'ordre de son plan.

## Contexte

L'ADR 0021 (§ 3) retient la lecture la plus sûre des deux consignes : tout déplacement sur la carte est une position de la simulation, interpolée au rendu ; l'animation tirée de l'activité est le geste, à sa place, que le rendu calcule pour les seuls visibles. Les planches de l'auteur (ADR 0016) ont sept rangées : repos (`idle`, 5 images), marche (`walk`, 8), course (`run`, 8), saut (`jump`, 4), chute (`fall`, 4, bras levés), lancer (`throw`, 6), mort (`death`, 10) ; le jeu ne range que les deux premières. Aucune ne montre la cueillette, le portage de l'eau ni la pêche. `animationFrame` et `animationOf` (`src/render/humans.ts`) attendaient 2b.8.

## Décision

### 1. Le geste, une fonction pure

- **La pose** (`poseOf`, `src/render/humans.ts`) : sur une étape, la marche, ou la course si l'octet d'activité de l'étape le dit (protocole 9, ADR 0021 § 6), jamais d'après la vitesse apparente, comme le gibier (ADR 0018, § 4) ; à l'arrêt, le geste de son activité. Elle rend l'animation et son image.
- **Fonction pure** de l'octet d'activité, de l'horloge de la marche du rendu et de la phase de l'individu, tirée de son identifiant (`splitmix32`, comme en 2b.5) : le même individu, au même instant affiché, montre toujours la même image. L'horloge de la marche n'avance qu'avec l'instant affiché : rien ne bouge en pause (mesuré : aucune image dessinée en pause, ADR 0015).
- **Les seuls visibles** : le calque ne calcule la pose que de ceux qu'il dessine (`lookGroup`, `layout`, ADR 0014 § 6). Le nourrisson porté prend l'animation et l'image de sa mère, dans son propre corps, comme en 2b.5.

### 2. Les gestes en données

`gestures` de `data/activities.json` : un geste est un cycle de segments, chacun des images d'une animation des planches (toutes, ou une liste de leurs rangs), à une durée par image (celle de l'animation sans elle), répétées. La période est la somme des segments ; l'image vaut celle du segment où tombe (horloge + phase × période) modulo la période. Le schéma borne segments (8), images (16), durées (de 40 à 4 000 ms) et répétitions (20) ; `checkContent` vérifie que chaque animation existe et a ces images. Les gestes vont avec les activités, dans `data/activities.json`, et non dans `data/humans.json`, que l'ADR 0016 (§ 6) laissait ouvert (« une table des données ») : `data/humans.json` décrit les planches (rangées, images, cadences, `shown`), un geste nomme des images de ces planches pour une activité, et `checkContent` lie les deux fichiers. Les gestes du prototype :

| Geste (activités) | Cycle | Période |
|---|---|---|
| repos (repos au camp, suivi du groupe à l'arrivée) | `idle`, sa cadence | 1,3 s |
| cueillette | `death` 2-3-4-3 à 320 ms, deux fois, puis `idle` une fois | 3,9 s |
| chasse, à l'affût | `idle` une fois, `throw` 1-2-3 à 260 ms, `throw` 3 tenu 900 ms, `throw` 2-1 à 260 ms | 3,5 s |
| coup du chasseur (`strike`, l'étape `ACT_STRIKE`) | `throw` entier à 150 ms | 0,9 s |
| pêche | `death` 3 tenu 1,8 s, puis `throw` 0 à 5 à 150 ms | 2,7 s |
| corvée d'eau | `death` 2-3 à 520 ms | 1,0 s |
| jeu | `jump`, `fall`, `jump`, `fall` à 110 ms, puis `idle` une fois | 3,1 s |

Les séjours face aux gestes (réalisation, critique requis 8) : un jour dure 111 ms à ×1, 27,8 ms à ×4, 6,9 ms à ×16 ; la pose suit l'horloge de la marche du rendu, et non le jour.

| Activité | Séjour (jours) | ×1 | ×4 | ×16 | Cycles du geste à ×1 |
|---|---|---|---|---|---|
| repos | 15 à 45 | 1,7 à 5,0 s | 0,42 à 1,25 s | 0,10 à 0,31 s | 1,3 à 3,8 |
| cueillette | 15 à 45 | 1,7 à 5,0 s | 0,42 à 1,25 s | 0,10 à 0,31 s | 0,4 à 1,3 |
| chasse | 15 à 45 au plus (jusqu'au coup) | 1,7 à 5,0 s | 0,42 à 1,25 s | 0,10 à 0,31 s | 0,5 à 1,4 |
| pêche | 15 à 45 | 1,7 à 5,0 s | 0,42 à 1,25 s | 0,10 à 0,31 s | 0,6 à 1,9 |
| corvée d'eau | 5 à 10 | 0,56 à 1,1 s | 0,14 à 0,28 s | 0,03 à 0,07 s | 0,5 à 1,1 (une image au moins) |
| jeu | 15 à 45 | 1,7 à 5,0 s | 0,42 à 1,25 s | 0,10 à 0,31 s | 0,5 à 1,6 |

À ×1, chaque séjour montre une image de son geste au moins, et le plus souvent un cycle ; à ×4 et ×16, moins d'un cycle : le geste se lit d'abord en pause et à ×1, ce que l'auteur peut juger (ADR 0021, point 14).

En chemin : la marche, et la course pour le jeu et la charge du chasseur (ADR 0021, § 3).

### 3. Images composées des planches, et ce qui manque

- **À genoux** : les images 2 à 4 de la mort, la figure assise sur ses talons avant de tomber, sont composées en un geste à genoux (cueillette, eau, pêche) : aucun pixel nouveau, les régions de l'habillage sont celles de la planche (toutes les animations sont déjà vérifiées et habillées, ADR 0016 § 6). Vu dans Chromium aux zooms 8, 16 et 24 sur PC et 8 sur Pixel 5 : il se lit comme un geste à terre, cueillir ou puiser.
- **Le lancer sans arme** : au zoom 16 ou 24, le chasseur à l'affût et le pêcheur lèvent le bras et lancent, mais les mains sont vides ; on lit un bras levé, presque un salut.
- **Ce qui manque, et demanderait des pixels nouveaux**, à soumettre à l'auteur : une lance (chasse, pêche), un panier (cueillette), une outre ou un pot porté au retour (eau), une pose assise (repos), un nourrisson dans les bras (ADR 0016, point 17). Trois voies : (a) les gestes composés, sans objet (le prototype) ; (b) des objets tenus en main, petits motifs du calque commun, posés sur un point de la main noté image par image dans les grilles de régions (une lettre de plus), aux couleurs de rôles : du code et des grilles, aucun pixel de planche retouché ; (c) des rangées nouvelles dessinées par l'auteur dans ses planches.

### 4. L'atlas du jeu

- **Mesuré au prototype**, les sept animations montrées, corps d'enfants compris : l'atlas des rôles passe de 1 024 × 129 à 1 024 × 471 texels (de 516 Kio à 1,8 Mio sur le GPU, en RGBA), de 598 à 2 070 motifs, son module de 188 à 684 ko ; le paquet principal de 1 533 à 2 036 ko (de 319 à 421 ko compressés) ; il se construit en 1,25 s.
- **Proposé** : `frames`, dans `data/humans.json`, les images d'une animation que le jeu range (la mort : 2, 3 et 4 seulement), les gestes gardant les rangs de la planche ; les corps d'enfants ne reçoivent que les animations de leurs activités (jeu : course, saut, chute ; cueillette et eau : à genoux ; pêche, dès 8 ans : lancer) ; de l'ordre de 1 750 motifs. Le budget du module (aujourd'hui moins de 200 ko, `tools/human-atlas.test.ts`) se fixe sur la mesure de la réalisation ; un atlas des gestes chargé à part, écarté par l'ADR 0016 pour 34 ko, se repèse à 100 ko compressés. *Réalisé sous le nom de `shown`, une liste de rangs, avec `young` pour les corps d'enfants : § 9.*
- **Les contrôles de l'atlas** qui ne valaient que pour le repos et la marche s'adaptent : les pieds sur la ligne (saut et chute sont en l'air), un visage à chaque image debout, la même tête tout au long d'une boucle (à genoux, elle descend).

### 5. Lisibilité selon le zoom

- **Dès le zoom 8** (planche ou facteur 1,5), à genoux, bras levé et sauts se distinguent ; une rive, un camp au bord d'une rivière vivent.
- **Aux zooms 3 et 4** (facteurs 3 et 4, 11 à 14 rangées), les gestes ne se lisent guère ; les allées et venues, si : des gens qui s'écartent du camp vers la rivière ou la steppe, et reviennent.
- **En forêt**, le décor passe devant (tri par les pieds, ADR 0017 § 7) : on y voit peu les activités, comme les gens au repos depuis 2b.6.

### 6. Ce que reçoit le fil principal

L'octet d'activité de chaque membre dans l'image des groupes (`GroupsFrame.activities`, jamais `ACT_STRIKE`), et celui de chaque étape (`HumanLegArrays.acts`, `ACT_STRIKE` le jour du coup : le geste `strike`, une fois, puis celui de l'activité) ; réalisés au temps 1 (ADR 0021, § 6 et § 11). Le porté a `ACT_NONE` : il prend la pose de qui le porte, comme sa fiche prend son activité (`PersonView.activity`) ; la ligne « Activité » de la fiche ajoutera sa clé (`person.activity`) à `src/i18n/fr.json` avec elle. Le miroir des positions (`PositionMirror`, `src/app/frames.ts`) garde celui de l'image, puis celui de la dernière étape appliquée ; une étape de zéro jour change le geste sur place, sans bouger. La disposition (`src/render/crowd.ts`) en tire la pose ; `animationOf` cède la place à `poseOf`. *Relecture de 2b.8 : à l'arrêt, le sens de chacun reste celui de son dernier pas horizontal (ADR 0016, § 6), et rien n'orientait le geste : le pêcheur et le porteur d'eau arrivés le long de la berge gardaient le sens de leur marche, dos à l'eau sur 36 à 38 % des relevés aux rives d'un bord vertical (la pêche de 34 à 39 %, la corvée d'eau autour de 50 %). Une étape de zéro jour au pas horizontal d'une unité, vers l'eau, les tourne désormais sans les déplacer (`shoreLegs`, `src/sim/activities.ts`) : posée à la rive, datée de l'instant où ils s'arrêtent, celui qui suit leur arrivée, à la fin du jour et après le pas mensuel, qui peut les mettre en partance. L'état ne change pas, ni les empreintes : seul le journal, une étape par arrivée au bord de l'eau. Le chasseur, lui, regarde déjà sa proie : son dernier pas va vers elle. Testé de bout en bout (étapes de la simulation, puis sens du miroir, aux rives des bords verticaux de deux graines) et au miroir seul (`src/app/frames.test.ts`).*

### 7. Le coût du rendu

Relevés du panneau de débogage, une valeur par seconde, mise à jour par tic + rendu par image :

| Écran, foule, zoom | 9f62e0a | Prototype |
|---|---|---|
| Pixel 5 ralenti ×4, 2 000, zoom 3, ×1 | 7,2 à 11,7 + 2,2 à 3,4 ms | 7,3 à 11,8 + 3,0 à 4,3 ms |
| PC 1 920 × 1 080, 4 000, zoom 3, ×1 | 3,2 à 5,5 + 1,3 à 1,9 ms | 3,5 à 8,6 + 1,7 à 2,2 ms (la première seconde, tous choisissent le même jour) |
| même, ×16 | 3,8 à 4,5 + 1,1 à 1,5 ms | 4,0 à 4,3 + 1,3 à 1,6 ms |
| en pause | 0,05 à 0,2 ms, rien de redessiné | de même |

La pose coûte quelques opérations par individu dessiné ; les marcheurs plus nombreux (51 à 55 % au lieu de 40 à 46 %) font un peu plus de positions par image. Même si presque tous marchaient chaque jour, le rendu ne paierait que les visibles : une position et une pose par individu à l'écran, comme aujourd'hui pour un marcheur ; c'est la simulation et les messages qui paieraient (ADR 0021, § 3). Le verdict reste celui des vrais appareils de l'auteur (NF-01).

*Mesuré sur la réalisation : § 9.*

### 8. Les tests

- **Pose** (`src/render/humans.test.ts`) : en marche, la marche ; avec le bit de course, la course ; à l'arrêt, les images de chaque geste aux instants voulus du cycle ; la phase décale le cycle ; même horloge, même image (pause) ; sans activité, le repos ; le porté dans la pose de sa mère.
- **Miroir** (`src/app/frames.test.ts`) : l'activité de l'image, puis des étapes ; l'étape d'arrêt ; rien ne change en pause.
- **Données** : geste inconnu, animation inconnue, image hors de l'animation refusés.
- **Atlas** (`tools/human-atlas.test.ts`) : les images rangées d'une animation à `frames` ; contrôles des pieds, du visage et de la tête adaptés aux gestes ; empreinte nouvelle.
- **Chromium** : un camp au bord d'une rivière aux zooms 8, 16 et 24 sur PC, 8 sur Pixel 5 ; le contrôle des pixels des humains (`tools/human-control/`) étendu aux gestes. La PR montre, comme toutes celles de la phase, des captures avant et après aux zooms 1, 2, 4 et 8, sur trois graines, sur PC et sur téléphone ; les tuiles de la carte n'y changent pas (aucun fichier de la carte n'est touché).

### 9. La réalisation

- **Les données.** Dans `data/humans.json`, `shown` vaut `true` (toutes les images) ou la liste croissante des rangs que le jeu range : pour la mort, `[2, 3, 4]`, la figure à genoux ; les gestes nomment les rangs de la planche, que l'atlas traduit (`ranks`). `young` dit les corps d'enfants et le nourrisson qui reçoivent chaque animation : le nourrisson, le repos, la marche, le lancer et la mort, puisque sa mère cueille, puise ou pêche, et ne court ni ne saute ; les enfants, toutes. Le repos et la marche sont rangés entiers, à tous les corps (le schéma le veut) ; un corps à qui manque l'animation de sa pose prend le repos. `checkContent` veut que chaque image d'un geste soit rangée par l'atlas du jeu, et chaque segment en millisecondes : le pas de la marche suit la vitesse de la partie, un geste l'horloge du rendu. Chaque refus a son test.
- **L'atlas mesuré** : de 598 à 1 668 motifs, de 1 024 × 129 à 1 024 × 374 rôles (de 0,5 à 1,5 Mio sur le GPU, en RGBA), son module de 188 à 544 ko (de 34 à 108 ko compressés), construit en 1,1 s ; le paquet principal de 1 533 à 1 899 ko (de 319 à 397 ko compressés), contre 2 036 et 421 au prototype, qui rangeait tout à tous les corps. Deux variantes ont été mesurées sans être retenues : les gestes aux seuls niveaux des facteurs 1 à 2 (les zooms 3 et 4 n'auraient que le repos et la marche), 1 200 motifs et 93 ko compressés ; aux facteurs 1 et 1,5, 966 motifs et 79 ko. De loin, un enfant à genoux ou en l'air se lit encore plus bas ou plus haut que les autres, et la pose changerait d'un zoom à l'autre, pour un gain de 15 à 29 ko compressés sur 397 (point 4). L'atlas des gestes chargé à part, au premier zoom de 8 ou plus, n'est pas fait : un second module à charger, puis à loger dans la texture des rôles commune, pour 100 ko compressés au plus (point 4). Les rôles bruts, compressés, pèseraient 64 ko au lieu de 99 en base64 : une piste pour tout l'atlas, hors de cette tâche.
- **Les enfants composés** gardent la tête de leur figure debout, réduite de même, et leur corps n'est jamais moins réduit (`youngRoles`) : à genoux, l'enfant est plus petit que debout, sa tête de même taille.
- **Les contrôles de l'atlas** (`tools/human-atlas.test.ts`) : le budget refixé sur la mesure (560 ko, 111 ko compressés) ; les pieds sur la ligne, sauf au saut, à la chute et à une foulée de la course, que l'auteur dessine en l'air ; un visage à chaque image ; la même tête au long des boucles debout ; l'enfant à genoux plus petit que debout ; des empreintes nouvelles.
- **La pose** (`poseOf`, `src/render/humans.ts`). Sur une étape, la marche, ou la course si l'octet porte `ACT_RUN` (le jeu, la charge). À l'arrêt, le cycle du geste de l'activité, précalculé à la construction (`poseTable` : par geste, sa période ; par pas, son début, son animation et son image rangée), lu par une recherche dichotomique, sans allocation. Le jour du coup (`ACT_STRIKE`, sans la course), le geste `strike`. Sans activité, ou pour un geste dont l'atlas ne range rien, le repos. `animationOf` disparaît. Périodes : repos 1,30 s, cueillette 3,86, chasse 3,50, pêche 2,70, eau 1,04, jeu 3,06. L'affût garde l'arme levée sans lancer (`throw` 1 à 3, tenu 0,9 s, puis 2 et 1) ; le coup joue le lancer entier, à 150 ms par image (ADR 0021, § 12 : il se voit peu à ×1).
- **La disposition** (`src/render/crowd.ts`). La pose ne se calcule que pour qui peut se voir, d'après le plus large et le plus haut des motifs du niveau, levée comprise, une fois par porteur, que ses portés prennent dans leur propre corps. Le saut et la chute, de 1 à 4 pixels au-dessus du sol, se posent au-dessus des pieds (`MOTIF_LIFT`) ; la profondeur et le tri avec le décor se font aux pieds. Le panneau de débogage compte les positions et les poses calculées.
- **Le fil principal** tient l'activité exacte du worker à chaque jour entier : ADR 0021, § 12, avec la correction de l'arrivée au camp.
- **Les tests**, chacun vérifié en retirant ce qu'il protège : la marche, la course, chaque geste aux instants voulus, la phase, la pause, le coup, le repos par défaut (`humans.test.ts`) ; la pose de chacun, le porté dans celle de sa mère, le sauteur en l'air, les seules poses visibles (`crowd.test.ts`) ; une position et une pose par individu à l'écran, aucune de loin (`people.test.ts`) ; l'octet de l'image puis des étapes, à leur jour, l'étape de zéro jour, le jour du coup, l'image du mois (`frames.test.ts`) ; les refus des données (`data.test.ts`). *Relecture de 2b.8 : trois protections n'étaient pas tenues, et ont leur test, chacun vérifié de même : le sauteur trié avec le décor par ses pieds, et non par le bas de son motif levé (`people.test.ts`) ; le porté qu'on voit quand sa mère est hors de l'écran, dans la pose de sa mère et non d'après les octets périmés de la disposition ; le repli au repos, à l'horloge du repos, d'un corps à qui l'atlas ne range pas l'animation de la pose (`crowd.test.ts`). Ces deux derniers cas ne se produisent pas avec les données : l'écart du porté (`display.carry`, 0,2 case) tient dans la marge du plus large motif, et une mère qui porte ne joue ni ne court ; le premier se vérifie au plus grand écart que permet le schéma (une demi-case), le second sur une mère qui court, que la simulation ne donne pas. La marge verticale de la visibilité compte la levée, mais ne change qu'un pixel : le plus haut motif levé est un adulte en pleine course, et non un sauteur (LEVEL_TALLEST vaut 47, 33, 25 et 16 rangées avec elle, 46, 32, 25 et 16 sans) ; aucun test ne la distingue.*
- **Le contrôle des pixels** (`tools/human-control`) reconnaît chaque particule des humains à son cadre et compte, par animation, ses particules et ses pixels comparés ; il veut, sur l'ensemble des vues, des pixels de la figure à genoux et d'un lancer, d'un saut ou d'une chute. Résultat, cinq vues : aucun écart sur 2 798 481 pixels comparés, ni rôle sans couleur ; des gestes comparés aux vues du zoom 4, sur PC et sur Pixel 5 : la figure à genoux sur 1 393 pixels, le lancer sur 874, le saut sur 64, la chute sur 13, la course sur 275 ; aux vues rapprochées, la foule de débogage, à peine apparue, se repose ou marche encore.
- **Les essais**, dans Chromium, contre 9f62e0a, servis côte à côte :
  - **Les camps au bord d'une rivière**, trois graines (`pixelciv` 489, 96 ; `graine` 509, 70 ; `autre` 256, 95), un groupe apparu par l'outil, les jours passés au bouton, aux zooms 8, 16 et 24 sur PC et 8 sur Pixel 5, au doigt. Pêcheurs et cueilleurs s'agenouillent sur la berge, le chasseur à l'affût lève le bras, les enfants sautent près des leurs ; chacun marche à son lieu, le joueur y court ; au pas du mois, le groupe suit son guide. Dès le zoom 8, les gestes se lisent, sur PC comme sur Pixel 5 ; aux zooms 3 et 4, on ne voit guère que les allées et venues (§ 5).
  - **Les planches de zoom**, avant et après, aux zooms 1, 2, 3, 4 et 8, trois graines, sur PC (1 280 × 720) et sur Pixel 5, trois groupes apparus au jour 0, capturés au jour 24, horloges figées : la carte seule, sans le calque commun, est la même au pixel près dans les trente paires ; la scène diffère de 0,0 à 1,3 %, par les gens et le gibier, dont la simulation a changé. Les tuiles ne sont pas touchées.
  - **La pause** : aucune image dessinée, 0,04 ms par tic sur PC, 0,14 ms sur le Pixel 5 ralenti. À ×16, les poses suivent l'horloge de la marche, comme à ×1.
  - **Les seules poses visibles**, au panneau de débogage : au zoom 8 sur PC, foule de 4 000, 3 988 positions et 2 379 poses calculées pour 2 902 sprites dessinés à ×1 ; 541 positions et 304 poses pour 327 sprites à ×16 ; aucune loin de la foule.
  - **Le coût par image** (mise à jour par tic, puis rendu par image dessinée ; médianes des relevés de chaque seconde ; SwiftShader) : PC 1 280 × 720, zoom 8, foule de 4 000 : 2,40 + 0,71 ms à ×1 (9f62e0a : 2,19 + 0,76), 1,12 + 0,42 ms à ×16 (1,10 + 0,41) ; PC 1 920 × 1 080, zoom 3 : 3,86 + 1,18 ms à ×1 (3,48 + 1,40), 4,06 + 1,03 ms à ×16 (3,71 + 1,07) ; Pixel 5 ralenti ×4, zoom 3, foule de 2 000, ×1 : 8,24 + 2,99 ms (7,23 + 2,96). La mise à jour coûte de 2 à 14 % de plus, et le rendu ne change guère (de −16 à +1 %) : la pose pèse peu à côté des positions et du tri, et les marcheurs, plus nombreux, font plus de positions. Le verdict reste celui des vrais appareils (NF-01).
  - **La mémoire** : le tas de la page passe de 18,4 à 22 Mo (23,4 Mo au Pixel 5) ; les textures des individus de 2 940 à 3 920 Kio, par l'atlas des rôles.
  - **Le sous-pas**, dans le worker de Chromium (PC 1 920 × 1 080, foule de 4 000) : le jour passe de 0,8-1,9 ms à 3,5-4,6 ms à ×1, aux premiers jours, où chacun fait ses premiers choix, et de 1,2-1,4 ms à 1,9-2,3 ms à ×16 (ADR 0021, § 9 et § 11).
  - **Une sauvegarde** : une partie de 2b.8 sauvegardée puis chargée redonne, à l'export, le même fichier octet pour octet, et la fiche du même individu la même activité (« suit son groupe », « sur le départ ») ; une sauvegarde de 9f62e0a (version 8) importée se migre, et la fiche d'un marcheur dit « suit son groupe ». L'avertissement de PixiJS au chargement (une texture détruite encore liée à un shader) vient aussi de 9f62e0a.

## Conséquences

- De près, chacun fait quelque chose, avec les seules images de l'auteur ; les gestes qui manquent sont nommés.
- Le paquet principal grossit de 366 ko, 78 ko compressés, pour l'atlas des gestes (§ 9) ; 100 ko compressés avec toutes les animations à tous les corps.

## Ce qui reste à décider par l'auteur

1. **À genoux** tiré des images 2 à 4 de la mort, pour la cueillette, l'eau et la pêche.
2. **Le lancer sans arme** ; et pour la lance, le panier, l'outre, la pose assise : objets en main (voie b), rangées nouvelles (voie c), ou rien (voie a).
3. **Les cycles des gestes** (durées, répétitions) du § 2.
4. **L'atlas** : sa taille (78 ko compressés de plus), les images retenues (`shown`), les animations des enfants (`young`) ; ou les gestes aux seuls niveaux rapprochés (15 à 29 ko de moins), ou un atlas des gestes chargé à part (§ 9).
5. **Les activités en forêt**, cachées par les arbres.
6. **Les gestes dans `data/activities.json`**, et non dans `data/humans.json` (§ 2), contrairement à la lettre du plan de la tâche ; `animationOf` remplacé par `poseOf` (§ 6).
7. **Le bras levé de l'affût**, sans arme, se lit comme un salut, à 16 comme à 24 (§ 3 et § 9) : le garder, le remplacer par le repos, ou attendre une lance (voies b et c).
