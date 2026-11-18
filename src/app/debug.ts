/**
 * Mesures du panneau de débogage (NF-01, ADR 0013) : images par seconde et image la plus
 * longue sur la dernière seconde ; durée moyenne d'un jour sur les mille derniers au moins ;
 * durée moyenne du pas mensuel et le plus long sur les douze derniers ; jours par lot sur
 * les trente derniers lots ; marches en cours au dernier lot.
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
  /** Marcheurs à la fin du dernier lot (ADR 0014). */
  readonly walkers: number | undefined;
}

/**
 * Jours ordinaires gardés pour leur moyenne, au moins. Hors isolement cross-origin,
 * l'horloge d'un worker n'avance que par pas de 0,1 ms : un jour de quelques microsecondes
 * s'y mesure 0 ou 0,1 ms, et seule une moyenne sur un millier de jours en approche la durée.
 */
export const DAY_WINDOW = 1000;
/** Pas mensuels et lots gardés pour les moyennes. */
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
  /** Durée totale des jours ordinaires de chacun des derniers lots, et leur nombre. */
  private days: { readonly total: number; readonly count: number }[] = [];
  private dayCount = 0;
  private months: number[] = [];
  private batches: number[] = [];
  private walkers: number | undefined;

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
    if (stats.dayMs !== undefined && ordinary > 0) {
      this.days.push({ total: stats.dayMs * ordinary, count: ordinary });
      this.dayCount += ordinary;
      // Les lots les plus anciens s'oublient, tant qu'il reste DAY_WINDOW jours sans eux.
      let first = this.days.at(0);
      while (first !== undefined && this.dayCount - first.count >= DAY_WINDOW) {
        this.days.shift();
        this.dayCount -= first.count;
        first = this.days.at(0);
      }
    }
    if (stats.monthMs !== undefined) keep(this.months, stats.monthMs, MONTH_WINDOW);
    if (stats.days > 0) keep(this.batches, stats.days, BATCH_WINDOW);
    this.walkers = stats.walkers;
  }

  sample(): DebugSample {
    const total = this.frames.reduce((sum, duration) => sum + duration, 0);
    return {
      fps: total > 0 ? (this.frames.length * 1000) / total : 0,
      worstFrameMs: Math.max(0, ...this.frames),
      dayMs:
        this.dayCount > 0
          ? this.days.reduce((sum, batch) => sum + batch.total, 0) / this.dayCount
          : undefined,
      monthMs: mean(this.months),
      worstMonthMs: this.months.length > 0 ? Math.max(...this.months) : undefined,
      batchDays: mean(this.batches),
      walkers: this.walkers,
    };
  }
}

/** Mémoire occupée par le tas JavaScript, en mégaoctets, si le navigateur la donne. */
export function usedMemoryMb(): number | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const bytes = memory?.usedJSHeapSize;
  return typeof bytes === 'number' ? bytes / (1024 * 1024) : undefined;
}
