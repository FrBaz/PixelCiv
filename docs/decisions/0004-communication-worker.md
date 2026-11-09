# ADR 0004 — Communication avec le worker

Statut : accepté · 9 novembre 2026 · tâche 0.2

## Contexte

La simulation tourne dans un fil séparé et ne bloque jamais l'interface (NF-02). Une seule simulation sert à tous les modes de jeu (MOD-01). Le `SharedArrayBuffer` est exclu : il exige des en-têtes HTTP (COOP et COEP) que GitHub Pages ne permet pas de définir.

## Décision

- **Un worker.** Un seul Web Worker, de type module, possède l'état du monde. Le fil principal n'en garde que ce qu'il affiche.
- **Protocole typé.** `src/core/protocol.ts` décrit tous les messages, en unions discriminées par leur champ `type`. La version du protocole est vérifiée dès la poignée de main, et le worker ne traite rien d'autre tant qu'elle n'a pas réussi.
- **Vers le worker.** Deux sortes de commandes :
  - les commandes de contrôle (vitesse, pause, sauvegarde, chargement, débogage), sans effet sur l'état ;
  - les commandes de jeu, qui modifient l'état : vérifiées à leur réception, elles attendent dans l'état le prochain pas, qui les horodate et les journalise (ADR 0003).

  Les opérations sur la partie entière (nouvelle partie, sauvegarde, chargement) passent dans une file, chacune après la fin de la précédente : la dernière partie demandée est celle qui reste. Toute requête de sauvegarde ou de chargement reçoit une réponse, même sans partie en cours. Changer de vitesse ou faire une pause garde l'avancée du mois en cours.
- **Vers le fil principal.** Un instantané complet au démarrage et après un chargement ; puis des deltas, qui portent les blocs de carte modifiés et le temps de la partie ; enfin des mesures, comme la durée des pas.
- **Transferts.** Les gros volumes, couches de carte par bloc et sauvegardes, voyagent en `ArrayBuffer` transférés, sans copie.
- **Hôte et simulation.** `src/worker/` héberge la simulation : il reçoit les messages, cadence les pas selon la vitesse et l'horloge, mesure leur durée et envoie les résultats. `src/sim/` ne connaît ni l'horloge ni les messages : il fait avancer l'état d'un pas.
- **Client.** Côté fil principal, `src/app/simulation.ts` enveloppe le worker dans un client typé.

## Conséquences

- La simulation se teste sous Node sans worker, et l'hôte avec une horloge et une messagerie factices.
- Un message mal formé est une erreur de type, et non une surprise à l'exécution.
- Le worker envoie des données, pas des images : la cuisson des blocs de carte reste côté rendu (tâche 1.7).
