# Décisions d'architecture

Chaque décision d'architecture fait l'objet d'un ADR court (CLAUDE.md, section « Méthode ») : contexte, décision, conséquences. Un ADR remplacé reste en place, avec son statut mis à jour et un renvoi vers celui qui le remplace.

| ADR | Sujet | Statut |
|---|---|---|
| [0001](0001-pile-technique.md) | Pile technique et outillage | accepté |
| [0002](0002-monde-cylindrique.md) | Monde cylindrique | accepté |
| [0003](0003-determinisme.md) | Déterminisme | accepté, révisé à la tâche 2b.6 (gibier dans l'état, flux `sim.fauna`, nouvelles empreintes de référence) |
| [0004](0004-communication-worker.md) | Communication avec le worker | accepté, révisé à la tâche 2b.6 (protocole 7 : image et étapes du gibier) |
| [0005](0005-traduction.md) | Traduction | accepté |
| [0006](0006-donnees.md) | Contenu en données | accepté |
| [0007](0007-sauvegardes.md) | Sauvegardes | accepté, révisé à la tâche 2b.6 (sauvegarde 8 : le gibier, migration de la 7) |
| [0008](0008-credits-et-licences.md) | Crédits et avis de licence | accepté |
| [0009](0009-generation-du-monde.md) | Génération du monde | accepté |
| [0010](0010-rendu-de-la-carte.md) | Rendu de la carte | accepté, révisé aux tâches 2b.4 (second programme des blocs, image à la demande), 2b.5 (humains peints par un shader de palettes) et 2b.6 (décor et gibier sur le calque des individus) |
| [0011](0011-individus-et-demographie.md) | Individus et démographie | accepté, révisé à la tâche 2b.5 (mini-sprites remplacés par les humains des planches, ADR 0016) |
| [0012](0012-camera-et-zoom.md) | Caméra et zoom | accepté ; unité du zoom soumise à l'auteur |
| [0013](0013-deux-horloges.md) | Deux horloges | accepté, révisé aux tâches 2b.3 (marche des groupes remplacée par l'ADR 0014), 2b.4 (mer animée au temps réel) et 2b.6 (jour et mois du gibier) ; interprétations soumises à l'auteur |
| [0014](0014-individus-hors-de-la-grille.md) | Individus hors de la grille | accepté, révisé aux tâches 2b.4 (rendu à la demande fait), 2b.5 (niveaux de motifs et règle du niveau, ADR 0016) et 2b.6 (décor à la densité des individus, appui ; gibier, protocole 7) ; écarts et interprétations soumis à l'auteur |
| [0015](0015-mer-animee.md) | Mer animée | accepté sous réserve de l'avis de l'auteur sur le motif et de l'essai sur son téléphone, révisé à la relecture (empreintes indépendantes des données, contrôle des pixels versé, mer jugée sur la partie visible des blocs) ; interprétations et écarts soumis à l'auteur |
| [0016](0016-humains-des-planches.md) | Humains tirés des planches | accepté, révisé à la tâche 2b.6 (calque commun, alpha du shader) ; style des tenues, interprétations et écarts soumis à l'auteur |
| [0017](0017-decor-en-objets.md) | Décor en objets | accepté, révisé à la seconde moitié de 2b.6 (gibier sur le calque commun) ; ombre, gisements, tailles et interprétations soumis à l'auteur |
| [0018](0018-gibier.md) | Gibier | accepté ; plafond, effectifs, comportement, dessins et interprétations soumis à l'auteur |
