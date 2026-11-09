/**
 * Racine de l'interface, superposée à la carte. Les barres du haut et du bas
 * accueillent les panneaux ; elles respectent les zones de sécurité (style.css).
 */
export function App() {
  return (
    <div class="hud">
      <div class="hud-bar hud-top" />
      <div class="hud-bar hud-bottom" />
    </div>
  );
}
