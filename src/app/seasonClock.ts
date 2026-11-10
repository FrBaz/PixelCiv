/**
 * Mois continu, pour le rendu des saisons (C1, D10) : le worker n'annonce que des pas
 * entiers, mais la neige doit avancer d'une image à l'autre, sans à-coups. Entre deux
 * pas, le mois progresse au rythme de la vitesse courante, et s'arrête en pause, juste
 * avant le mois suivant, en attendant le pas.
 */
import type { TimeInfo } from '../core/protocol';
import { MONTHS_PER_YEAR, monthDuration } from '../core/time';

export class SeasonClock {
  private time: TimeInfo | undefined;
  /** Instant (ms) où le pas courant a commencé, ou s'est figé. */
  private anchor = 0;
  /** Avancée du mois au moment de l'ancrage, de 0 à 1. */
  private progress = 0;

  /** Nouvelles informations de temps, à l'instant `now` (ms). */
  update(time: TimeInfo, now: number): void {
    const previous = this.time;
    const advanced = previous?.tick !== time.tick;
    this.progress = advanced ? 0 : this.progressAt(now);
    this.anchor = now;
    this.time = time;
  }

  /** Mois continu à l'instant `now` : 0 au début de janvier, juste sous 12 fin décembre. */
  month(now: number): number {
    const time = this.time;
    if (time === undefined) return 0;
    return (time.tick % MONTHS_PER_YEAR) + this.progressAt(now);
  }

  private progressAt(now: number): number {
    const time = this.time;
    if (time === undefined) return 0;
    if (time.paused) return this.progress;
    const elapsed = (now - this.anchor) / monthDuration(time.speed);
    return Math.min(0.999, this.progress + elapsed);
  }
}
