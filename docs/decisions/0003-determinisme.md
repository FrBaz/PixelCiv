# ADR 0003 — Déterminisme

Statut : accepté · 9 novembre 2026 · tâche 0.2

## Contexte

Une même graine et les mêmes paramètres doivent donner le même monde sur tous les appareils, et une partie relancée depuis une sauvegarde doit se dérouler à l'identique (NF-09). Or la norme JavaScript laisse chaque moteur approcher à sa façon `Math.sin`, `Math.exp` ou `Math.pow`, et `Math.random` ne se rejoue pas.

## Décision

- **Aléatoire.** Un seul générateur, xoshiro128** : 128 bits d'état et des opérations entières exactes sur 32 bits. Il est découpé en flux nommés (`src/core/rng.ts`), un par système. Chaque flux dérive de la graine du monde et de son nom, et non de l'ordre de création des flux. L'état des flux est sauvegardé.
- **Fonctions mathématiques.** `src/core/dmath.ts` fournit `sin`, `cos`, `exp`, `log` et `pow`, écrites avec les seules opérations qu'IEEE 754 définit exactement : addition, soustraction, multiplication, division, racine carrée et arrondis. Réduction de l'argument puis série de Taylor (ou d'atanh pour `log`) ; les constantes découpées de π/2 et de ln 2 ont été recalculées en rationnels exacts. Précision mesurée face aux fonctions du moteur : 1 ulp pour `exp`, 3 ulp pour `log` ; pour `sin` et `cos`, 2 ulp jusqu'à 1,6 × 10^6 (2^20 × π/2), zéros compris, puis des valeurs toujours déterministes et dans [-1, 1], mais imprécises. `pow` est exacte pour les puissances entières de deux et les petites puissances entières d'entiers ; ailleurs, son erreur relative reste sous 10^-14 pour un exposant entier jusqu'à 64, et sous 4 × 10^-14 pour un résultat entre 10^-30 et 10^30. Près des débordements, elle atteint 3 × 10^-13, et un résultat voisin de la limite peut passer du mauvais côté.
- **Empreintes.** `src/core/hash.ts` calcule des empreintes FNV-1a. Les bits d'un NaN varient d'un processeur à l'autre : les empreintes n'en voient qu'une forme canonique.
- **Interdits.** Dans `src/core`, `src/sim`, `src/worldgen` et `src/gen`, ESLint refuse `Math.random`, `crypto`, `Date`, `performance`, les fonctions de Math approchées, l'opérateur `**`, `Intl` et les méthodes qui dépendent de la langue de l'appareil, y compris par `globalThis` ou `self`. `Math`, `globalThis` et `self` ne s'y emploient que devant une propriété écrite en clair (`Math.sqrt`, `Math['sqrt']`) : un alias (`const M = Math`), un détour (`globalThis.self`) ou une clé calculée (`Math[op]`) échapperait à ces interdictions. Les requêtes de type, comme `typeof Math.sin`, restent admises.
- **Temps.** La simulation compte ses pas et ne lit jamais l'horloge. Seul l'hôte du worker (`src/worker`, ADR 0004) la lit, pour cadencer les pas.
- **Commandes.** Une commande qui modifie l'état est horodatée du pas où elle s'applique, appliquée au début de ce pas, puis journalisée. Rejouer une partie revient à rejouer son journal à partir de la même graine.
- **Contrôle.** Des tests comparent l'empreinte de l'état (FNV-1a sur 32 bits) après N pas à une valeur de référence. Au démarrage, le jeu recalcule aussi les valeurs de référence du générateur et de `dmath` dans le navigateur, et le panneau de débogage indique si elles concordent.

## Conséquences

- Toute fonction mathématique nouvelle passe par `dmath`, et toute dérive se voit dans les tests d'empreinte.
- Une différence entre navigateurs se voit sur le téléphone même, dans le panneau de débogage.
- `dmath` est plus lent que les fonctions natives. L'interface et le rendu, qui n'influencent pas l'état, gardent les fonctions natives.
