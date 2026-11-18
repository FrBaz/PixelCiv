/**
 * Horloge du rendu (ADR 0013) : l'instant que montre la carte, en jours écoulés depuis le
 * début de la partie, fractionnaires. Les saisons en tirent leur mois, les groupes leur
 * position, l'interface sa date. Le worker n'annonce que des jours entiers, par lots ;
 * cette horloge avance en continu, d'une image à l'autre, sans à-coups.
 *
 * - Elle ne dépasse jamais le dernier état reçu : aucune extrapolation, donc aucun retour
 *   en arrière.
 * - Elle avance à la vitesse de la partie, corrigée lentement pour garder un peu de retard
 *   sur le dernier état, de quoi couvrir l'attente du lot suivant, et celle du pas
 *   mensuel, plus long. Le retard mesuré juste avant chaque arrivée d'un état, lissé par
 *   une moyenne exponentielle (τ = 0,5 s), vise C = max(½ lot, dernier pas mensuel) ; le
 *   rythme vaut vitesse × borne(1 + (L̄ − C) / 2C, ½, 2). Mesuré à chaque arrivée plutôt
 *   qu'à chaque image, le retard ne fait pas pulser le mouvement au rythme des lots.
 * - En pause, elle finit son retard à la vitesse de la partie, en 0,3 s au plus, et
 *   s'arrête sur le dernier état : ce qu'on voit en pause est l'état, et la reprise
 *   repart de là.
 * - Au-delà de max(1 s, 2 × retard visé) de retard, au retour d'un onglet par exemple,
 *   elle saute au dernier état, comme à l'instantané d'une partie.
 */
import type { TimeInfo } from '../core/protocol';
import {
  batchDays,
  dayDuration,
  dayIndex,
  DAYS_PER_MONTH,
  MONTHS_PER_YEAR,
  timeOfDayIndex,
  type GameTime,
  type SpeedId,
} from '../core/time';

/** Constante de temps du lissage du retard, en millisecondes. */
export const SMOOTHING_MS = 500;
/** Durée maximale du rattrapage en pause, en millisecondes. */
export const PAUSE_CATCH_UP_MS = 300;
/** Retard au-delà duquel l'horloge saute au dernier état, au moins, en millisecondes. */
export const JUMP_MS = 1000;

export class GameClock {
  /** Instant affiché et instant du dernier état reçu, en jours écoulés (dayIndex). */
  private shown = 0;
  private latest = 0;
  private speed: SpeedId = 'normal';
  private paused = false;
  /** Instant (ms) de la dernière avancée de l'horloge. */
  private lastNow: number | undefined;
  /** Retard juste avant l'arrivée d'un état, lissé, en jours, et instant de cette arrivée. */
  private smoothed: number | undefined;
  private lastArrival: number | undefined;
  /** En pause : rythme du rattrapage, en jours par milliseconde. */
  private catchUp = 0;
  /** Durée du dernier pas mensuel, en millisecondes. */
  private monthMs = 0;

  /** Instantané d'une partie, à l'instant `now` (ms) : l'horloge saute à son instant. */
  reset(time: TimeInfo, now: number): void {
    this.shown = dayIndex(time);
    this.latest = this.shown;
    this.speed = time.speed;
    this.paused = time.paused;
    this.lastNow = now;
    this.smoothed = undefined;
    this.lastArrival = undefined;
    this.catchUp = 0;
  }

  /**
   * Nouveau temps, à l'instant `now` (ms) : un état plus récent (delta), ou un changement
   * de vitesse ou de pause. L'horloge avance d'abord jusqu'à `now` à l'ancienne vitesse.
   */
  receive(time: TimeInfo, now: number): void {
    this.advance(now);
    const index = dayIndex(time);
    if (index > this.latest) {
      // En marche, le retard juste avant l'arrivée de l'état, lissé. Le premier d'une
      // partie, ou d'une reprise, part du retard visé : la vitesse de la partie.
      if (!this.paused && !time.paused) {
        const before = this.latest - this.shown;
        if (this.smoothed === undefined || this.lastArrival === undefined) {
          this.smoothed = Math.max(before, this.target());
        } else {
          const weight = 1 - Math.exp(-(now - this.lastArrival) / SMOOTHING_MS);
          this.smoothed += weight * (before - this.smoothed);
        }
        this.lastArrival = now;
      }
      this.latest = index;
    }
    this.speed = time.speed;
    if (time.paused !== this.paused) this.lastArrival = undefined;
    this.paused = time.paused;
    if (this.paused) {
      // Le retard se finit à la vitesse de la partie, ou plus vite s'il dépasse 0,3 s.
      this.catchUp = Math.max(
        1 / dayDuration(this.speed),
        (this.latest - this.shown) / PAUSE_CATCH_UP_MS,
      );
    }
  }

  /** Durée du pas mensuel du dernier lot qui en a eu un, en millisecondes. */
  monthStep(milliseconds: number): void {
    this.monthMs = Math.max(0, milliseconds);
  }

  /** Avance l'horloge jusqu'à l'instant `now` (ms), et renvoie l'instant affiché. */
  advance(now: number): number {
    const last = this.lastNow ?? now;
    this.lastNow = now;
    const elapsed = now - last;
    const lag = this.latest - this.shown;
    if (!(elapsed > 0) || lag <= 0) return this.shown;
    const day = dayDuration(this.speed);
    const target = this.target();
    const wanted = target + batchDays(this.speed);
    if (lag * day > Math.max(JUMP_MS, 2 * wanted * day)) {
      this.shown = this.latest;
      return this.shown;
    }
    let rate: number;
    if (this.paused) {
      rate = this.catchUp;
    } else {
      const smoothed = this.smoothed ?? target;
      rate = Math.min(2, Math.max(0.5, 1 + (smoothed - target) / (2 * target))) / day;
    }
    this.shown = Math.min(this.latest, this.shown + rate * elapsed);
    return this.shown;
  }

  /** Instant affiché, en jours écoulés, fractionnaires. */
  get instant(): number {
    return this.shown;
  }

  /** Instant du dernier état reçu, en jours écoulés. */
  get received(): number {
    return this.latest;
  }

  /** Jour en cours à l'instant affiché : le mois et les jours écoulés de ce mois. */
  today(): GameTime {
    return timeOfDayIndex(Math.floor(this.shown));
  }

  /** Mois continu de l'année à l'instant affiché : 0 au début de janvier, sous 12 fin décembre. */
  month(): number {
    return (this.shown / DAYS_PER_MONTH) % MONTHS_PER_YEAR;
  }

  /** Retard visé juste avant l'arrivée d'un état, en jours : C = max(½ lot, pas mensuel). */
  private target(): number {
    return Math.max(batchDays(this.speed) / 2, this.monthMs / dayDuration(this.speed));
  }
}
