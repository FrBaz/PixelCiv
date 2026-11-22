import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFECTS,
  defaultEffects,
  EFFECT_LEVELS,
  EFFECTS_KEY,
  effectSettings,
  initialEffects,
  loadEffects,
  parseEffectLevel,
  preferenceStore,
  saveEffects,
  softwareRenderer,
  type PreferenceStore,
} from './effects';

/** Un stockage en mémoire, qui peut refuser la lecture ou l'écriture. */
class MemoryStore implements PreferenceStore {
  readonly items = new Map<string, string>();
  private readonly refuseRead: boolean;
  private readonly refuseWrite: boolean;
  constructor(refuseRead = false, refuseWrite = false) {
    this.refuseRead = refuseRead;
    this.refuseWrite = refuseWrite;
  }
  getItem(key: string): string | null {
    if (this.refuseRead) throw new Error('SecurityError');
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.refuseWrite) throw new Error('QuotaExceededError');
    this.items.set(key, value);
  }
}

describe('réglage des effets (ADR 0020)', () => {
  it('donne à chaque cran sa mer et ses couleurs de la saison, sans force intermédiaire', () => {
    expect(EFFECT_LEVELS).toEqual(['full', 'reduced', 'off']);
    expect(effectSettings('full', false)).toEqual({ sea: 1, seasons: 'full' });
    // Le cran du milieu : la mer à demi, les états de la végétation sans la lumière d'hiver.
    expect(effectSettings('reduced', false)).toEqual({ sea: 0.5, seasons: 'states' });
    expect(effectSettings('off', false)).toEqual({ sea: 0, seasons: 'off' });
  });

  it('éteint la mer à tous les crans quand l’utilisateur demande moins de mouvement', () => {
    for (const level of EFFECT_LEVELS) {
      const settings = effectSettings(level, true);
      expect(settings.sea).toBe(0);
      expect(settings.seasons).toBe(effectSettings(level, false).seasons);
    }
  });

  it('lit le cran gardé, et rien d’autre qu’un cran', () => {
    const store = new MemoryStore();
    expect(loadEffects(store)).toBeUndefined();
    store.items.set(EFFECTS_KEY, 'reduced');
    expect(loadEffects(store)).toBe('reduced');
    for (const unknown of ['', 'FULL', 'plein', '1', 'off ']) {
      store.items.set(EFFECTS_KEY, unknown);
      expect(loadEffects(store), unknown).toBeUndefined();
    }
    expect(loadEffects(undefined)).toBeUndefined();
    // Un stockage qui lève une exception à la lecture (navigation privée, site sans données).
    expect(loadEffects(new MemoryStore(true))).toBeUndefined();
  });

  it('garde le cran choisi, sans rien casser si le stockage refuse ou manque', () => {
    const store = new MemoryStore();
    expect(saveEffects(store, 'off')).toBe(true);
    expect(store.items.get(EFFECTS_KEY)).toBe('off');
    expect(loadEffects(store)).toBe('off');
    expect(saveEffects(new MemoryStore(false, true), 'full')).toBe(false);
    expect(saveEffects(undefined, 'full')).toBe(false);
  });

  it('ouvre le stockage de l’appareil, ou rien s’il manque ou refuse de s’ouvrir', () => {
    const store = new MemoryStore();
    expect(preferenceStore({ localStorage: store })).toBe(store);
    expect(preferenceStore({})).toBeUndefined();
    const refusing = {
      get localStorage(): unknown {
        throw new Error('SecurityError');
      },
    };
    expect(preferenceStore(refusing)).toBeUndefined();
  });

  it('coupe les effets par défaut en rendu logiciel, et les garde pleins ailleurs', () => {
    expect(defaultEffects({ software: true, touchOnly: false })).toBe('off');
    expect(defaultEffects({ software: true, touchOnly: true })).toBe('off');
    // Au doigt seul, pleins en attendant l'essai sur le téléphone de l'auteur (le repli de l'ADR
    // 0015, § 12, est une ligne de la table).
    expect(defaultEffects({ software: false, touchOnly: true })).toBe(DEFAULT_EFFECTS.touch);
    expect(DEFAULT_EFFECTS.touch).toBe('full');
    expect(defaultEffects({ software: false, touchOnly: false })).toBe('full');
  });

  it('reconnaît les moteurs de rendu logiciels', () => {
    for (const name of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'Google SwiftShader',
      'Microsoft Basic Render Driver',
    ]) {
      expect(softwareRenderer(name), name).toBe(true);
    }
    for (const name of [
      'Adreno (TM) 620',
      'Apple GPU',
      'ANGLE (NVIDIA GeForce RTX 3060)',
      'Mali-G78',
    ]) {
      expect(softwareRenderer(name), name).toBe(false);
    }
    expect(softwareRenderer(undefined)).toBe(false);
  });

  it('prend le cran de l’adresse, sinon celui gardé, sinon celui de l’appareil', () => {
    const store = new MemoryStore();
    const pc = { software: false, touchOnly: false };
    const software = { software: true, touchOnly: false };
    expect(initialEffects(null, store, pc)).toBe('full');
    expect(initialEffects(null, store, software)).toBe('off');
    store.items.set(EFFECTS_KEY, 'reduced');
    expect(initialEffects(null, store, software)).toBe('reduced');
    expect(initialEffects('off', store, pc)).toBe('off');
    expect(initialEffects('inconnu', store, pc)).toBe('reduced');
    expect(initialEffects(null, new MemoryStore(true), software)).toBe('off');
    expect(parseEffectLevel('full')).toBe('full');
    expect(parseEffectLevel(undefined)).toBeUndefined();
  });
});
