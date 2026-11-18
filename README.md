# Captures

Branche orpheline de PixelCiv qui range les captures d'écran montrées dans les PR, en particulier les planches « avant » et « après ». Elle ne contient aucun code et n'est jamais fusionnée : une PR intègre ses images par des liens `raw.githubusercontent.com` qui nomment un commit précis de cette branche.

Un dossier par tâche, au nom de son ticket du backlog :

- `2b.1/` : zoom et caméra ;
- `2b.2/` : deux horloges. Les planches de zoom (`<graine>-<appareil>.png`) montrent que la carte n'a pas changé ; les planches du mouvement (`mouvement-<appareil>.png`, huit images à 150 ms d'écart) et les animations (`mouvement-<appareil>.gif`, 4 s, avant et après côte à côte) montrent un groupe qui sautait d'une case à l'autre à chaque mois et qui marche désormais jour après jour.

Les planches reproduisent les captures au pixel près, sans mise à l'échelle ni lissage. Les animations gardent les pixels de l'écran, mais réduisent les couleurs à 256, sans tramage.
