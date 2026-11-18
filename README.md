# Captures

Branche orpheline de PixelCiv qui range les captures d'écran montrées dans les PR, en particulier les planches « avant » et « après ». Elle ne contient aucun code et n'est jamais fusionnée : une PR intègre ses images par des liens `raw.githubusercontent.com` qui nomment un commit précis de cette branche.

Un dossier par tâche, au nom de son ticket du backlog :

- `2b.1/` : zoom et caméra ;
- `2b.2/` : deux horloges. Les planches de zoom (`<graine>-<appareil>.png`) montrent que la carte n'a pas changé ; les planches du mouvement (`mouvement-<appareil>.png`, huit images à 150 ms d'écart) et les animations (`mouvement-<appareil>.gif`, 4 s, avant et après côte à côte) montrent un groupe qui sautait d'une case à l'autre à chaque mois et qui marche désormais jour après jour ;
- `2b.3/` : individus découplés des pixels. Les planches de zoom (`<graine>-<appareil>.png`) montrent trois groupes apparus sur les mêmes cases dans les deux versions, 34 jours plus tard : la carte n'a pas changé, les individus si. Les planches rapprochées, aux zooms 8, 16 et 24, montrent un groupe au repos (`repos-<appareil>.png`) et en marche (`marche-<appareil>.png`) ; les animations (`marche-<appareil>.gif`, 4 s au zoom 16, avant et après côte à côte) montrent la grappe qui marchait d'un bloc et les individus qui partent désormais chacun à son jour, à son allure.

Les planches reproduisent les captures au pixel près, sans mise à l'échelle ni lissage. Les animations gardent les pixels de l'écran, mais réduisent les couleurs à 256, sans tramage.
