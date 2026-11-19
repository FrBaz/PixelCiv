/**
 * Cadence de l'image (tâche 2b.4 ; ADR 0010 et ADR 0015) : ce que l'image de chaque tic lit
 * de l'horloge et des réglages pour la mer animée, et la signature de ce qu'elle montre, que
 * le rendu à la demande compare d'un tic à l'autre (src/render/frameGate.ts). Des fonctions
 * pures, que src/app/main.ts appelle à chaque tic.
 */
import type { Camera, Extent } from '../render/camera';
import { WAVE_STEP_MS } from '../render/waves';
import type { DisplayOverrides } from './debug';

/** Pas et force de la mer animée d'une image (src/render/map.ts, setWaves). */
export interface WaveInputs {
  /** Pas de l'onde, entier et sans borne. */
  readonly step: number;
  /** Force, de 0 (pas d'onde) à 1. */
  readonly force: number;
}

/**
 * Pas et force de la mer animée de l'image de l'instant `now`, en millisecondes de temps réel
 * de l'affichage (performance.now(), jamais celui de la simulation) : un pas tous les
 * WAVE_STEP_MS, sauf si `?waveStep=N` le fixe ; la force vaut `seaMotion`, le réglage des
 * effets (src/ui/store.ts, point d'entrée de la tâche 2b.7), ou 0 si `?waves=off` l'éteint ou
 * si l'utilisateur demande moins de mouvement (`reducedMotion`, prefers-reduced-motion).
 */
export function waveInputs(
  overrides: DisplayOverrides,
  reducedMotion: boolean,
  seaMotion: number,
  now: number,
): WaveInputs {
  return {
    step: overrides.waveStep ?? Math.floor(now / WAVE_STEP_MS),
    force: overrides.waves && !reducedMotion ? seaMotion : 0,
  };
}

/** Ce que montre une image, partie par partie. */
export interface FrameParts {
  /** Instant affiché de la partie, qui date les saisons, les individus et la date. */
  readonly shown: number;
  readonly camera: Camera;
  /** Taille de l'écran en pixels physiques, et sa densité. */
  readonly viewport: Extent;
  readonly resolution: number;
  /** Signature de la carte (MapView.signature) et version du calque des individus. */
  readonly map: readonly number[];
  readonly people: number;
}

/**
 * Signature de l'image : chaque partie de ce qu'elle montre. Elle se calcule après le dessin
 * de la carte et des individus, dont elle lit l'état à cette image (la carte ne dit qu'après
 * son dessin si l'onde est à l'écran). Tout calque nouveau y ajoute sa version (ADR 0010) :
 * ce qu'elle ne voit pas resterait figé.
 */
export function frameSignature(parts: FrameParts): readonly number[] {
  const { camera, viewport } = parts;
  return [
    parts.shown,
    camera.x,
    camera.y,
    camera.zoom,
    viewport.width,
    viewport.height,
    parts.resolution,
    ...parts.map,
    parts.people,
  ];
}
