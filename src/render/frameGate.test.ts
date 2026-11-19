import { describe, expect, it } from 'vitest';
import { FrameGate, invalidateOnRestore } from './frameGate';

describe('image à la demande (ADR 0010, tâche 2b.4)', () => {
  it('ne redessine pas une image dont la signature ne change pas', () => {
    const gate = new FrameGate();
    const parts = [12.5, 100, 200, 2, 1280, 720, 1, 7, -0.97, 1, -1, 3];
    expect(gate.changed(parts)).toBe(true);
    expect(gate.changed([...parts])).toBe(false);
    expect(gate.changed([...parts])).toBe(false);
    // NaN égal à NaN : une partie indéfinie ne fait pas redessiner chaque image.
    expect(gate.changed([...parts, Number.NaN])).toBe(true);
    expect(gate.changed([...parts, Number.NaN])).toBe(false);
  });

  it('redessine une fois chaque partie changée', () => {
    const gate = new FrameGate();
    const parts = [0, 1, 2, 3, 4, 5, 6, 7];
    gate.changed(parts);
    for (let index = 0; index < parts.length; index++) {
      const next = parts.slice();
      next[index] = (next[index] ?? 0) + 0.5;
      expect(gate.changed(next)).toBe(true);
      expect(gate.changed(next)).toBe(false);
      expect(gate.changed(parts)).toBe(true);
    }
    expect(gate.changed(parts.slice(1))).toBe(true);
  });

  it('redessine une fois après une invalidation', () => {
    const gate = new FrameGate();
    gate.changed([1]);
    gate.invalidate();
    expect(gate.changed([1])).toBe(true);
    expect(gate.changed([1])).toBe(false);
  });

  it('invalide l’image au retour du contexte WebGL, au premier plan et à la reprise de la page', () => {
    const gate = new FrameGate();
    const canvas = new EventTarget();
    const window = new EventTarget();
    const visibility: { visibilityState: DocumentVisibilityState } = { visibilityState: 'hidden' };
    const document = Object.assign(new EventTarget(), visibility);
    invalidateOnRestore(gate, { canvas, document, window });
    gate.changed([1]);
    // Masquée, la page ne redessine rien.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(gate.changed([1])).toBe(false);
    for (const [target, type] of [
      [canvas, 'webglcontextrestored'],
      [window, 'pageshow'],
    ] as const) {
      target.dispatchEvent(new Event(type));
      expect(gate.changed([1])).toBe(true);
      expect(gate.changed([1])).toBe(false);
    }
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(gate.changed([1])).toBe(true);
  });
});
