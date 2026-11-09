/**
 * Mesures du panneau de débogage (NF-01) : images par seconde et image la plus
 * longue sur la dernière seconde, durée des pas sur les derniers pas reçus.
 */

export interface DebugSample {
  /** Images par seconde, sur la dernière seconde. */
  readonly fps: number;
  /** Image la plus longue de la dernière seconde, en millisecondes. */
  readonly worstFrameMs: number;
  /** Durée moyenne et plus longue des derniers pas, en millisecondes. */
  readonly stepMs: number | undefined;
  readonly worstStepMs: number | undefined;
}

/** Nombre de pas gardés pour la moyenne. */
const STEP_WINDOW = 30;
/** Fenêtre des images, en millisecondes. */
const FRAME_WINDOW_MS = 1000;

export class DebugSampler {
  private frames: number[] = [];
  private steps: number[] = [];

  /** Enregistre la durée d'une image. */
  frame(durationMs: number): void {
    this.frames.push(durationMs);
    let total = this.frames.reduce((sum, duration) => sum + duration, 0);
    while (this.frames.length > 1 && total - (this.frames[0] ?? 0) >= FRAME_WINDOW_MS) {
      total -= this.frames.shift() ?? 0;
    }
  }

  /** Enregistre la durée d'un pas de simulation. */
  step(durationMs: number): void {
    this.steps.push(durationMs);
    if (this.steps.length > STEP_WINDOW) this.steps.shift();
  }

  sample(): DebugSample {
    const total = this.frames.reduce((sum, duration) => sum + duration, 0);
    const steps = this.steps;
    return {
      fps: total > 0 ? (this.frames.length * 1000) / total : 0,
      worstFrameMs: Math.max(0, ...this.frames),
      stepMs:
        steps.length > 0 ? steps.reduce((sum, value) => sum + value, 0) / steps.length : undefined,
      worstStepMs: steps.length > 0 ? Math.max(...steps) : undefined,
    };
  }
}

/** Mémoire occupée par le tas JavaScript, en mégaoctets, si le navigateur la donne. */
export function usedMemoryMb(): number | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const bytes = memory?.usedJSHeapSize;
  return typeof bytes === 'number' ? bytes / (1024 * 1024) : undefined;
}
