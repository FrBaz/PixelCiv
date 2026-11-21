/**
 * Réglage des effets (tâche 2b.7 ; ADR 0020) : trois crans, pleins, atténués, coupés, gardés
 * dans les préférences de l'appareil (localStorage), hors de la sauvegarde de la partie. Il règle
 * la mer animée (sa force, ADR 0015, § 7) et les couleurs de la saison (ADR 0019, § 2 et 3) ; la
 * neige et la glace, une information de jeu que la pêche lit aussi, n'en dépendent pas.
 *
 * Le cran du milieu est un sous-ensemble cohérent des effets, jamais un mélange : la mer à demi
 * (moins de crêtes et de clapots), les états de la végétation sans la lumière d'hiver (la critique
 * de la conception, requis 3 : une force de 0,5 tramait la moitié des pixels toute la saison).
 * Une demande de mouvement réduit (prefers-reduced-motion) éteint la mer à tous les crans ; les
 * couleurs de la saison restent, qui ne bougent pas.
 *
 * Fonctions pures : main.ts lit l'appareil, l'adresse et le stockage, et les leur passe.
 */

export const EFFECT_LEVELS = ['full', 'reduced', 'off'] as const;
export type EffectLevel = (typeof EFFECT_LEVELS)[number];

/**
 * Ce que montrent les couleurs de la saison : les états de la végétation et la lumière d'hiver,
 * les états seuls, ou rien (src/render/map.ts, setSeasonColors).
 */
export type SeasonColors = 'full' | 'states' | 'off';

/** Ce qu'un cran donne aux effets. */
export interface EffectSettings {
  /** Force de la mer animée, de 0 (immobile) à 1 (ADR 0015, § 7). */
  readonly sea: number;
  readonly seasons: SeasonColors;
}

const SETTINGS: Readonly<Record<EffectLevel, EffectSettings>> = {
  full: { sea: 1, seasons: 'full' },
  reduced: { sea: 0.5, seasons: 'states' },
  off: { sea: 0, seasons: 'off' },
};

/** Ce que donne le cran `level` ; le mouvement réduit éteint la mer. */
export function effectSettings(level: EffectLevel, reducedMotion: boolean): EffectSettings {
  const settings = SETTINGS[level];
  return reducedMotion ? { ...settings, sea: 0 } : settings;
}

/** Clé de la préférence dans le stockage de l'appareil. */
export const EFFECTS_KEY = 'pixelciv.effects';

/** Ce que l'appareil permet de garder : localStorage, ou rien. */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Le stockage des préférences, s'il existe et s'ouvre : en navigation privée, ou quand le site n'a
 * pas le droit de garder de données, y toucher peut lever une exception.
 */
export function preferenceStore(scope: {
  readonly localStorage?: unknown;
}): PreferenceStore | undefined {
  try {
    const store = scope.localStorage as PreferenceStore | undefined;
    return store ?? undefined;
  } catch {
    return undefined;
  }
}

/** Le cran que nomme `text`, s'il en est un. */
export function parseEffectLevel(text: string | null | undefined): EffectLevel | undefined {
  return EFFECT_LEVELS.find((level) => level === text);
}

/** Le cran gardé, s'il y en a un et qu'il se lit ; undefined sinon. */
export function loadEffects(store: PreferenceStore | undefined): EffectLevel | undefined {
  try {
    return parseEffectLevel(store?.getItem(EFFECTS_KEY));
  } catch {
    return undefined;
  }
}

/** Garde le cran choisi ; un stockage plein ou refusé ne fait perdre que la préférence. */
export function saveEffects(store: PreferenceStore | undefined, level: EffectLevel): boolean {
  try {
    if (store === undefined) return false;
    store.setItem(EFFECTS_KEY, level);
    return true;
  } catch {
    // Le cran vaut pour la session.
    return false;
  }
}

/** Ce que l'appareil dit de lui pour le cran par défaut. */
export interface EffectDevice {
  /** Rendu logiciel (SwiftShader, llvmpipe…), où l'onde et les saisons divisent les images. */
  readonly software: boolean;
  /** Au doigt seul, sans pointeur fin (`(any-pointer: fine)` faux) : un téléphone, une tablette. */
  readonly touchOnly: boolean;
}

/**
 * Le cran par défaut de chaque sorte d'appareil (ADR 0020) : coupés en rendu logiciel, le repli
 * de l'ADR 0015 (§ 12) étendu aux saisons ; pleins au doigt seul, en attendant l'essai sur le
 * téléphone de l'auteur (NF-01) : si la cible n'y tient qu'au cran coupé, cette ligne le dit ;
 * pleins ailleurs.
 */
export const DEFAULT_EFFECTS: Readonly<Record<'software' | 'touch' | 'pointer', EffectLevel>> = {
  software: 'off',
  touch: 'full',
  pointer: 'full',
};

export function defaultEffects(device: EffectDevice): EffectLevel {
  if (device.software) return DEFAULT_EFFECTS.software;
  return device.touchOnly ? DEFAULT_EFFECTS.touch : DEFAULT_EFFECTS.pointer;
}

/** Les noms de moteurs de rendu qui dessinent en logiciel (WEBGL_debug_renderer_info). */
const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|software|softpipe|basic render/i;

/** Le moteur de rendu `renderer` dessine-t-il en logiciel ? */
export function softwareRenderer(renderer: string | undefined): boolean {
  return renderer !== undefined && SOFTWARE_RENDERERS.test(renderer);
}

/**
 * Le cran de départ : celui de l'adresse (`?effects=full|reduced|off`, pour les captures, qui ne
 * se garde pas), sinon celui que l'appareil a gardé, sinon celui de l'appareil.
 */
export function initialEffects(
  query: string | null,
  store: PreferenceStore | undefined,
  device: EffectDevice,
): EffectLevel {
  return parseEffectLevel(query) ?? loadEffects(store) ?? defaultEffects(device);
}
