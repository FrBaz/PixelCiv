import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Garde contre le retour des couleurs calculées d'avant 2b.5 (ADR 0016, § 3) : les modules qui
// recolorent les humains n'appellent plus shade, skinColor, greyed, ni le mélange de deux tons
// d'une rampe. Ce n'est qu'une recherche de texte : la garantie que chaque couleur d'un humain est
// un ton déclaré vient de src/render/humans.test.ts (toutes les apparences, tous les rôles) et,
// pour ce que peint le GPU, du contrôle des pixels tools/human-control/.

describe('couleurs des humains', () => {
  it('n’appelle aucune des fonctions de couleur calculée d’avant 2b.5 : shade, skinColor, greyed, mélange de rampe', () => {
    for (const file of ['humans.ts', 'looks.ts', 'humanShader.ts', 'atlas.ts']) {
      const source = readFileSync(new URL(`../src/render/${file}`, import.meta.url), 'utf8');
      for (const banned of ['shade(', 'skinColor', 'greyed(', 'Math.round(a[']) {
        expect(source.includes(banned), `${file} : ${banned}`).toBe(false);
      }
    }
  });
});
