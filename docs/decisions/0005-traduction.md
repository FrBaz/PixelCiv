# ADR 0005 — Traduction

Statut : accepté · 9 novembre 2026 · tâche 0.9

## Contexte

Aucun texte affiché n'est écrit en dur : tout passe par la traduction (NF-06), le français d'abord. Les titres se déclinent au féminin (POL-04). Le plan (section 3) prévoit un petit système maison, avec des clés, des pluriels et le genre.

## Décision

- **Catalogue.** `src/i18n/fr.json` associe des clés plates (`app.title`, `calendar.month.january`…) à des messages. Le français fait référence : une autre langue reprendra les mêmes clés.
- **Messages.** Un message est :
  - un texte, avec des paramètres `{nom}` ;
  - ou des formes plurielles (`one`, `other`… selon `Intl.PluralRules`), choisies par le paramètre `count`, `other` servant de repli ;
  - ou des formes selon le genre (`masculine`, `feminine`), choisies par le paramètre `gender`, elles-mêmes textes ou formes plurielles.

  Les nombres sont mis en forme selon la langue.
- **Appels.** `t(clé, paramètres)` n'accepte que les clés du catalogue : une clé inconnue est une erreur de compilation. `tKey` sert aux clés qui viennent des données (`data/`), vérifiées par les tests.
- **Contrôles.**
  - Un test vérifie que le catalogue est bien formé, que toutes les clés passées à `t()` existent et qu'aucune clé ne reste inutilisée.
  - ESLint refuse le texte écrit en dur dans le JSX : entre les balises, en chaîne ou en gabarit, directement ou par une condition (`{a ? 'Oui' : 'Non'}`), ainsi que dans les attributs lus par l'utilisateur (`title`, `aria-label`, `alt`, `placeholder`…). Il ne suit pas les variables : un texte rangé dans une constante lui échappe.
- **Repli.** À l'exécution, une clé absente s'affiche telle quelle plutôt que de faire planter l'interface.

## Conséquences

- Un texte se crée en même temps que sa clé, dans le même commit.
- Les clés construites dynamiquement sont à éviter : une liste explicite de clés permet au test de les retrouver.
- La traduction vit côté fil principal : la simulation produit des clés et des paramètres, jamais du texte.
