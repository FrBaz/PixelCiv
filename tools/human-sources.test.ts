import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Les humains des planches n'emploient aucune couleur calculée (ADR 0016, § 3) : les modules
// qui les recolorent ne font appel à aucune fonction qui éclaircit, mêle ou interpole un ton.

describe('couleurs des humains', () => {
  it('n’emploie aucune couleur calculée : ni éclaircie, ni mêlée, ni interpolée', () => {
    for (const file of ['humans.ts', 'looks.ts', 'humanShader.ts', 'atlas.ts']) {
      const source = readFileSync(new URL(`../src/render/${file}`, import.meta.url), 'utf8');
      for (const banned of ['shade(', 'skinColor', 'greyed(', 'Math.round(a[']) {
        expect(source.includes(banned), `${file} : ${banned}`).toBe(false);
      }
    }
  });
});
