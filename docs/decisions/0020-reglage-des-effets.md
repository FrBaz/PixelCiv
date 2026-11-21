# ADR 0020 — Réglage des effets

Statut : accepté · 21 novembre 2026 · tâche 2b.7, avec l'ADR 0019 ; réalisé au second temps (commit a226c3a), et repris après la critique de la conception : le cran du milieu n'a plus de force intermédiaire. Essayé dans Chromium, à la souris sur PC et au doigt sur Pixel 5 émulé. Les points de la dernière section sont soumis à l'auteur.

## Contexte

La consigne de 2b.7 demande « un réglage des effets » ; le backlog, qu'il « atténue ou coupe ces effets ». La mer animée attendait le sien : `seaMotion` (`src/ui/store.ts`) en était le point d'entrée, que rien n'exposait ni ne gardait (ADR 0015, § 7), et l'ADR 0015 fixe un repli (§ 12) : si la cible de NF-01 n'est pas tenue sur un vrai téléphone avec l'onde, elle s'éteint par défaut sur les appareils au doigt seul, comme sous un rendu logiciel. Le jeu ne gardait encore aucune préférence : pas de `localStorage` dans `src/`, et les sauvegardes, dans IndexedDB, ne portent que la partie (ADR 0007).

La conception proposait un cran « atténué » de force 0,5 pour les saisons, la moitié des pixels qui changeraient, tirée au hasard : la critique (requis 3) y a vu un damier vert et roux toute la saison, un mélange de deux palettes au pixel qu'aucun état ne montre, qui n'allège pas le coût (un programme coûte autant à toute force non nulle).

## Décision

- **Ce qu'il règle** : la mer animée (la force de l'onde, ADR 0015, § 7) et les couleurs de la saison (les états de la végétation et la lumière d'hiver, ADR 0019, § 2 et 3), et, avec elles, la lumière d'hiver des objets du décor. La neige et la glace n'en dépendent pas : c'est une information de jeu (P0), que la pêche lit, et le programme de base les porte. Les états du décor (automne, bois nu, saison sèche, neige) non plus : ce sont ceux de 2b.6, sur le calendrier de la végétation.
- **Trois crans, chacun un sous-ensemble cohérent des effets** (`src/ui/effects.ts`, `effectSettings`) :
  - **pleins** : la mer à 1, les états de la végétation et la lumière d'hiver ;
  - **atténués** : la mer à 0,5 (moins de crêtes et de clapots), les états de la végétation sans la lumière d'hiver ;
  - **coupés** : la mer immobile, aucune couleur de saison sur le sol : chaque bloc prend le programme de base, la carte de ses tuiles avec la neige et la glace ; les objets du décor gardent leurs états (point 3), et l'aide du cran le dit (corrigé à la relecture, problème 4 : elle promettait une carte « sans couleurs de saison »).
  Hors de leurs transitions de douze jours, aucune case ne mêle deux états, à aucun cran (test). Le coût suit le cran : coupés, le programme de base, et rien d'autre ne se compile au premier monde (corrigé à la relecture, problème 7 : les trois programmes de l'onde et des saisons s'y compilaient pour rien, 290 à 320 ms du fil principal sous SwiftShader ; ADR 0019, § 6) ; atténués, celui des saisons, sur moins de blocs l'hiver (la lumière en élargit le masque), et l'onde, dont la force ne change pas le travail : ce cran ne coûte guère moins que le plein (mesuré, ADR 0019, § 6).
- **L'interface** (`src/ui/EffectsMenu.tsx`) : un groupe « Effets : Pleins · Atténués · Coupés » dans la barre du bas, après les modes de carte ; au téléphone, dans la ligne qui défile. Boutons à `aria-pressed` ; l'explication du cran choisi, écrite en clair sous les boutons (`#effects-hint`), qu'ils désignent par `aria-describedby`, et une infobulle par cran pour la souris (au doigt, `title` ne s'ouvre jamais : corrigé à la relecture, problème 4) ; textes par `t()` (`effects.menu`, `effects.full`, `effects.reduced`, `effects.off` et leurs `.hint` dans `src/i18n/fr.json`), visibles pendant une partie seulement, comme les modes.
- **Où il se garde** : une préférence de l'appareil, hors de la sauvegarde de la partie : `localStorage`, clé `pixelciv.effects`, lue au démarrage avant la première image, écrite à chaque choix ; chaque accès passe par un `try` (navigation privée, stockage refusé ou plein, `localStorage` qui lève une exception à la lecture) : sans stockage, le cran vaut pour la session. Une partie exportée ne l'emporte pas : il appartient à l'appareil, non au monde.
- **Mouvement réduit** : `prefers-reduced-motion` éteint la mer à tous les crans, suivi à chaque image ; les couleurs de la saison restent, qui ne bougent pas d'une image à l'autre : une transition dure douze jours de jeu, soit 1,33 s à ×1, 0,33 s à ×4 et 83 ms à ×16, où l'année entière des couleurs défile en 2,5 s (`NORMAL_YEAR_MS`, 40 s). Corrigé à la relecture (problème 16) : la première rédaction disait « plus d'une seconde même à ×16 » ; la question d'atténuer les couleurs sous le mouvement réduit aux vitesses rapides est soumise à l'auteur (point 5).
- **Les crans par défaut** (`DEFAULT_EFFECTS`) : coupés sous un rendu logiciel (SwiftShader, llvmpipe, reconnus par `WEBGL_debug_renderer_info`), où l'onde et les saisons divisent les images : le repli de l'ADR 0015 (§ 12), étendu aux saisons ; pleins sur un appareil au doigt seul (`(any-pointer: fine)` faux), en attendant l'essai de l'auteur sur son téléphone ; pleins ailleurs. Le repli est fixé : si NF-01 n'y est tenu qu'au cran coupé, la ligne `touch` de la table devient `off`.
- **Débogage** : `?effects=full|reduced|off` fixe le cran sans le garder, pour les captures ; `?waves=off` reste.
- **Code** : `src/ui/effects.ts`, fonctions pures (crans, ce qu'ils donnent, lecture et écriture de la préférence, défauts par appareil, moteurs logiciels) ; `effectsLevel` dans `src/ui/store.ts`, dont `seaMotion` se déduit ; `UiActions.setEffects` ; `src/app/main.ts` en tire à chaque image la force de la mer, les couleurs de la saison de la carte (`MapView.setSeasonColors`) et la lumière du décor.

## Mesuré

Voir l'ADR 0019, § 6 : images dessinées et rendu par image à chaque cran, en pause, à ×1 et à ×16, sur PC et sur Pixel 5 ralenti ×4 (SwiftShader). En bref, à ×1 sur PC au zoom 2 : 9,5 images par seconde aux crans pleins, 8,6 aux crans atténués, 33,3 aux crans coupés, contre 13,4 et 38,4 en e5b1f3f avec et sans l'onde ; en pause, sans onde, aucune image. Sous un rendu logiciel, seul le cran coupé rend le coût d'avant, d'où le défaut de ces appareils.

## Protocole d'essai sur le téléphone de l'auteur (NF-01)

1. Ouvrir la partie sur le téléphone, monde Petit puis Moyen, zoom 2 puis 4, au cran plein, dans un hiver du nord (une forêt mêlée et la mer dans la vue) ; ouvrir le panneau de débogage (F3 sur PC, son bouton au téléphone) et lire les images dessinées par seconde et le rendu par image, en pause, à ×1 et à ×16.
2. Recommencer aux crans atténués et coupés.
3. Si le cran plein tient 30 images par seconde à ×1 et à ×16, le défaut des appareils au doigt reste plein ; si seul le cran atténué les tient, il devient atténué ; sinon, coupé (une ligne de `DEFAULT_EFFECTS`).

## Conséquences

- Le jeu garde sa première préférence d'appareil ; la langue ou l'échelle de l'interface pourront suivre le même chemin.
- La mer animée et les saisons se coupent d'un geste, ce qui rend aussi leur coût ; le cran coupé rend la carte du premier temps de 2b.7 au pixel près.
- Le réglage ne touche ni la sauvegarde ni le protocole.

## Ce qui reste à décider par l'auteur

1. **Trois crans** et leur sens (atténués : la mer à demi, la végétation sans la lumière d'hiver), ou deux crans, ou un réglage par effet (mer, saisons, lumière). Le cran atténué allège l'image, non le travail du GPU : s'il doit aussi coûter moins, il lui faudrait la mer immobile (l'onde est l'effet le plus cher sous SwiftShader) et les seuls états de la végétation.
2. **La neige et la glace hors du réglage**, information de jeu.
3. **Les états du décor hors du réglage** (ceux de 2b.6), contre l'annonce de l'ADR 0017 (§ 5) ; seule la lumière d'hiver des objets suit le cran.
4. **La place** : dans la barre du bas, après les modes de carte, plutôt qu'un menu d'options à part.
5. **Le mouvement réduit**, qui n'éteint que la mer ; aux vitesses rapides, les couleurs de la saison changent pourtant vite (une transition en 83 ms à ×16, l'année en 2,5 s) : faut-il les figer, ou les couper, sous le mouvement réduit au-delà de ×4 ?
6. **Les défauts** : coupés en rendu logiciel ; pleins au doigt seul en attendant l'essai sur son téléphone (protocole ci-dessus), puis atténués ou coupés si NF-01 l'exige.
