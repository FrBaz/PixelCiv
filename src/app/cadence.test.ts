import { describe, expect, it } from 'vitest';
import { FrameGate } from '../render/frameGate';
import { CREST_CYCLE, CREST_LIFE, RIPPLE_CYCLE, RIPPLE_LIFE, WAVE_STEP_MS } from '../render/waves';
import { frameSignature, waveInputs, type FrameParts } from './cadence';
import { displayOverrides } from './debug';

const overrides = (search = '') => displayOverrides(new URLSearchParams(search));

describe('cadence de la mer animée (ADR 0015)', () => {
  it('avance d’un pas toutes les 250 ms de temps réel : une boucle lente', () => {
    // Les durées de l'ADR 0015 (§ 2) : une crête vit 3 s et revient toutes les 4 s, un clapot
    // dure une demi-seconde toutes les 16 s, le cadre glisse de 4 pixels de carte par seconde.
    expect(CREST_LIFE * WAVE_STEP_MS).toBe(3000);
    expect(CREST_CYCLE * WAVE_STEP_MS).toBe(4000);
    expect(RIPPLE_LIFE * WAVE_STEP_MS).toBe(500);
    expect(RIPPLE_CYCLE * WAVE_STEP_MS).toBe(16_000);
    const step = (now: number) => waveInputs(overrides(), false, 1, now).step;
    expect(step(0)).toBe(0);
    expect(step(WAVE_STEP_MS - 0.01)).toBe(0);
    expect(step(WAVE_STEP_MS)).toBe(1);
    expect(step(1000)).toBe(4);
    expect(step(60_000) - step(59_000)).toBe(4);
    // Après des heures, un entier exact.
    expect(step(36_000_000.7)).toBe(144_000);
  });

  it('prend la force du réglage des effets, nulle sous mouvement réduit ou ?waves=off', () => {
    const force = (search: string, reduced: boolean, seaMotion: number) =>
      waveInputs(overrides(search), reduced, seaMotion, 1234).force;
    // seaMotion passe tel quel : le point d'entrée du réglage de 2b.7.
    expect(force('', false, 1)).toBe(1);
    expect(force('', false, 0.5)).toBe(0.5);
    expect(force('', false, 0)).toBe(0);
    expect(force('', true, 1)).toBe(0);
    expect(force('', true, 0.5)).toBe(0);
    expect(force('?waves=off', false, 1)).toBe(0);
    expect(force('?waves=on', false, 0.25)).toBe(0.25);
  });

  it('fixe le pas par ?waveStep, quel que soit l’instant', () => {
    expect(waveInputs(overrides('?waveStep=17'), false, 1, 99_999).step).toBe(17);
    expect(waveInputs(overrides('?waveStep=17'), true, 1, 5).step).toBe(17);
    expect(waveInputs(overrides('?waveStep=-3'), false, 1, 1000).step).toBe(4);
  });
});

describe('signature de l’image (rendu à la demande, ADR 0010)', () => {
  const base: FrameParts = {
    shown: 10.25,
    camera: { x: 128, y: 384, zoom: 2 },
    viewport: { width: 1280, height: 720 },
    resolution: 1,
    map: [7, -0.5, 1, 42],
    people: 3,
  };

  it('change quand une partie de l’image change, chacune seule, et seulement alors', () => {
    const variants: FrameParts[] = [
      { ...base, shown: 10.5 },
      { ...base, camera: { ...base.camera, x: 129 } },
      { ...base, camera: { ...base.camera, y: 383 } },
      { ...base, camera: { ...base.camera, zoom: 3 } },
      { ...base, viewport: { ...base.viewport, width: 1281 } },
      { ...base, viewport: { ...base.viewport, height: 719 } },
      { ...base, resolution: 2 },
      // Chaque partie de la signature de la carte : version, saison, force, pas de l'onde.
      ...base.map.map((value, index) => ({
        ...base,
        map: base.map.map((part, rank) => (rank === index ? value + 1 : part)),
      })),
      { ...base, people: 4 },
    ];
    const gate = new FrameGate();
    expect(gate.changed(frameSignature(base))).toBe(true);
    expect(gate.changed(frameSignature({ ...base, camera: { ...base.camera } }))).toBe(false);
    for (const variant of variants) {
      expect(gate.changed(frameSignature(variant))).toBe(true);
      expect(gate.changed(frameSignature(variant))).toBe(false);
      expect(gate.changed(frameSignature(base))).toBe(true);
    }
  });
});
