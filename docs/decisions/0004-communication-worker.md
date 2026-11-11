# ADR 0004 — Communication avec le worker

Statut : accepté · 9 novembre 2026 · tâche 0.2 ; révisé le 11 novembre 2026 (protocole 4, relecture de la phase 2)

## Contexte

La simulation tourne dans un fil séparé et ne bloque jamais l'interface (NF-02). Une seule simulation sert à tous les modes de jeu (MOD-01). Le `SharedArrayBuffer` est exclu : il exige des en-têtes HTTP (COOP et COEP) que GitHub Pages ne permet pas de définir.

## Décision

- **Un worker.** Un seul Web Worker, de type module, possède l'état du monde. Le fil principal n'en garde que ce qu'il affiche.
- **Protocole typé.** `src/core/protocol.ts` décrit tous les messages, en unions discriminées par leur champ `type`. La version du protocole est vérifiée dès la poignée de main, et le worker ne traite rien d'autre tant qu'elle n'a pas réussi. C'est la version 4 à la fin de la phase 2 ; la 3 n'a jamais été publiée.
- **Vers le worker.** Trois sortes de messages :
  - les commandes de contrôle (vitesse, pause, sauvegarde, chargement, débogage), sans effet sur l'état ;
  - les commandes de jeu, qui modifient l'état : vérifiées à leur réception, elles attendent dans l'état le prochain pas, qui les horodate et les journalise (ADR 0003). En pause, elles s'appliquent dès leur réception, comme au début du pas qui vient, et se journalisent avec lui ; la mise en pause applique aussi celles qui attendaient. Une apparition hors du monde ou sur une case infranchissable est refusée dès sa réception, par une erreur `command`, sans entrer en attente ni au journal.
  - les demandes de fiche, d'un individu ou d'un groupe, et de pages de la chronique : chaque réponse porte le numéro de sa demande. Le groupe touché se choisit sur le fil principal, d'après les bannières et les mini-sprites que la carte dessine (`pickGroup`, `src/render/crowd.ts`), qui demande ensuite sa fiche. Le fil principal ignore une réponse antérieure à la dernière demande du joueur, à la fermeture de la fiche ou à un instantané, et ne rafraîchit une fiche ouverte que si aucune réponse n'est attendue (`src/app/sheets.ts`).

  Les opérations sur la partie entière (nouvelle partie, sauvegarde, chargement) passent dans une file, chacune après la fin de la précédente : la dernière partie demandée est celle qui reste. Toute requête de sauvegarde ou de chargement reçoit une réponse qui porte son numéro, même sans partie en cours ou quand l'écriture échoue. Changer de vitesse ou faire une pause garde l'avancée du mois en cours.
- **Vers le fil principal.** Un instantané complet au démarrage et après un chargement : les paramètres du monde et ses dix couches (ADR 0009), l'image des groupes et les 300 derniers faits de la chronique (ADR 0011). Puis des deltas, qui portent les blocs de carte modifiés, le temps de la partie, l'image des groupes et les faits nouveaux, chacun avec son rang ; un delta suit chaque pas, ou, en pause, une commande appliquée aussitôt. Enfin des mesures, comme la durée des pas, comptée du début du pas à l'envoi de son delta : image des groupes, faits de la chronique et copie du message compris. Une page de la chronique ne va jamais au-delà des faits déjà envoyés : aucun fait n'arrive deux fois. Pendant la génération d'un monde, le worker annonce chaque étape commencée, puis la durée totale.
- **Aperçu.** L'écran de création demande des aperçus : le même monde, sur une carte réduite, dont le worker renvoie le biome et l'altitude. Un aperçu ne touche pas à la partie et passe hors de la file des opérations.
- **Transferts.** Les gros volumes, couches du monde, blocs modifiés, aperçus et sauvegardes, voyagent en `ArrayBuffer` transférés, sans copie : le worker envoie des copies de ses couches, qu'il garde.
- **Hôte et simulation.** `src/worker/` héberge la simulation : il reçoit les messages, cadence les pas selon la vitesse et l'horloge, mesure leur durée et envoie les résultats. `src/sim/` ne connaît ni l'horloge ni les messages : il fait avancer l'état d'un pas. Une exception ne fige pas la partie : celle d'une commande l'écarte, sans effet sur l'état ni place au journal (ADR 0003), et se signale par une erreur `command` ; celle d'un mois se signale par une erreur `internal`. Dans les deux cas, le pas suivant vient à son heure.
- **Client.** Côté fil principal, `src/app/simulation.ts` enveloppe le worker dans un client typé.

## Conséquences

- La simulation se teste sous Node sans worker, et l'hôte avec une horloge et une messagerie factices.
- Un message mal formé est une erreur de type, et non une surprise à l'exécution.
- Le worker envoie des données, pas des images : la cuisson des blocs de carte reste côté rendu (tâche 1.7).
- Un mois interrompu par une exception laisse l'état à moitié avancé : rien ne revient en arrière, et un rejeu en divergerait. La partie continue, et l'erreur est signalée.
