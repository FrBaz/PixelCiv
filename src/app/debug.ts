/**
 * Mesures du panneau de débogage (NF-01, ADR 0013) : images par seconde et image la plus
 * longue sur la dernière seconde ; durée moyenne d'un jour sur les trente derniers ; durée
 * moyenne du pas mensuel et le plus long sur les douze derniers ; jours par lot sur les
 * trente derniers lots ; marches en cours au dernier lot.
 */
import type { StepStats } from '../core/protocol';

export interface DebugSample {
  /** Images par seconde, sur la dernière seconde. */
  readonly fps: number;
  /** Image la plus longue de la dernière seconde, en millisecondes. */
  readonly worstFrameMs: number;
  /** Durée moyenne d'un jour ordinaire, hors pas mensuel, en millisecondes. */
  readonly dayMs: number | undefined;
  /** Durée moyenne et plus longue des derniers pas mensuels, en millisecondes. */
  readonly monthMs: number | undefined;
  readonly worstMonthMs: number | undefined;
  /** Jours par lot, en moyenne sur les derniers lots. */
  readonly batchDays: number | undefined;
  /** Marches en cours à la fin du dernier lot. */
  readonly walks: number | undefined;
}

/** Jours, pas mensuels et lots gardés pour les moyennes. */
const DAY_WINDOW = 30;
const MONTH_WINDOW = 12;
const BATCH_WINDOW = 30;
/** Fenêtre des images, en millisecondes. */
const FRAME_WINDOW_MS = 1000;

const mean = (values: readonly number[]) =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

/** Ajoute une valeur au bout d'une fenêtre, qui ne garde que les `size` dernières. */
function keep(values: number[], value: number, size: number): void {
  values.push(value);
  if (values.length > size) values.splice(0, values.length - size);
}

export class DebugSampler {
  private frames: number[] = [];
  private days: number[] = [];
  private months: number[] = [];
  private batches: number[] = [];
  private walks: number | undefined;

  /** Enregistre la durée d'une image. */
  frame(durationMs: number): void {
    this.frames.push(durationMs);
    let total = this.frames.reduce((sum, duration) => sum + duration, 0);
    while (this.frames.length > 1 && total - (this.frames[0] ?? 0) >= FRAME_WINDOW_MS) {
      total -= this.frames.shift() ?? 0;
    }
  }

  /** Enregistre les mesures d'un lot de jours du worker. */
  batch(stats: StepStats): void {
    const ordinary = stats.days - (stats.monthMs === undefined ? 0 : 1);
    if (stats.dayMs !== undefined) {
      for (let day = 0; day < Math.min(ordinary, DAY_WINDOW); day++) {
        keep(this.days, stats.dayMs, DAY_WINDOW);
      }
    }
    if (stats.monthMs !== undefined) keep(this.months, stats.monthMs, MONTH_WINDOW);
    if (stats.days > 0) keep(this.batches, stats.days, BATCH_WINDOW);
    this.walks = stats.walks;
  }

  sample(): DebugSample {
    const total = this.frames.reduce((sum, duration) => sum + duration, 0);
    return {
      fps: total > 0 ? (this.frames.length * 1000) / total : 0,
      worstFrameMs: Math.max(0, ...this.frames),
      dayMs: mean(this.days),
      monthMs: mean(this.months),
      worstMonthMs: this.months.length > 0 ? Math.max(...this.months) : undefined,
      batchDays: mean(this.batches),
      walks: this.walks,
    };
  }
}

/** Mémoire occupée par le tas JavaScript, en mégaoctets, si le navigateur la donne. */
export function usedMemoryMb(): number | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const bytes = memory?.usedJSHeapSize;
  return typeof bytes === 'number' ? bytes / (1024 * 1024) : undefined;
}
