/**
 * Images des groupes datées (ADR 0013). Le worker envoie l'image des groupes quand elle
 * change, au pas mensuel et après une commande, avec les marches du mois ; elle vaut à
 * partir de l'instant de l'état qui la porte. La carte montre l'image de l'instant affiché
 * par l'horloge du rendu (GameClock), et non la dernière reçue : apparitions, scissions,
 * réunions et extinctions s'y voient à leur instant, en même temps que la date et les
 * saisons, et chaque groupe suit sa marche du mois jusqu'au bout avant de prendre la
 * suivante, de la même case.
 */
import type { GroupsFrame } from '../core/protocol';
import { dayIndex, DAYS_PER_MONTH, type GameTime } from '../core/time';

/** Une image des groupes, et l'instant à partir duquel elle vaut. */
export interface DatedFrame {
  /** Instant, en jours écoulés depuis le début de la partie (dayIndex). */
  readonly at: number;
  /** Mois de ses marches : au jour fractionnaire t de la partie, elles en sont à t − 30 × tick. */
  readonly tick: number;
  readonly frame: GroupsFrame;
  /** Indice de la marche de chaque groupe qui en a une, par identifiant de groupe. */
  readonly walkOf: ReadonlyMap<number, number>;
}

/** L'image `frame` d'un état de l'instant `time`. */
export function datedFrame(frame: GroupsFrame, time: GameTime): DatedFrame {
  const walkOf = new Map<number, number>();
  frame.walks.groups.forEach((group, index) => walkOf.set(group, index));
  return { at: dayIndex(time), tick: time.tick, frame, walkOf };
}

/** Jour du mois des marches d'une image à l'instant `shown`, fractionnaire, de 0 à 30. */
export function walkDay(dated: DatedFrame, shown: number): number {
  return Math.min(DAYS_PER_MONTH, Math.max(0, shown - dated.tick * DAYS_PER_MONTH));
}

/**
 * Images gardées au plus. Le retard de l'horloge reste bien en deçà (une image par mois et
 * par commande) ; la borne tient la mémoire d'un onglet en arrière-plan. L'horloge y avance
 * encore, à chaque état reçu, mais la carte ne s'y dessine plus : aucune image n'y est
 * demandée, et les images reçues s'entasseraient. Au retour de l'onglet, la première image
 * dessinée fait oublier toutes celles que l'horloge a dépassées.
 */
export const MAX_FRAMES = 16;

/** File des images datées, de la plus ancienne encore utile à la dernière reçue. */
export class FrameQueue {
  private frames: DatedFrame[] = [];

  /** Instantané d'une partie : sa seule image. */
  reset(frame: GroupsFrame, time: GameTime): void {
    this.frames = [datedFrame(frame, time)];
  }

  /** Une nouvelle image ; celle d'un même instant (commande en pause) remplace la précédente. */
  push(frame: GroupsFrame, time: GameTime): void {
    const dated = datedFrame(frame, time);
    const last = this.frames.at(-1);
    if (last !== undefined && last.at >= dated.at) this.frames.pop();
    this.frames.push(dated);
    if (this.frames.length > MAX_FRAMES) this.frames.splice(0, this.frames.length - MAX_FRAMES);
  }

  /** L'image de l'instant `shown` ; celles qu'il a dépassées s'oublient. */
  at(shown: number): DatedFrame | undefined {
    while (this.frames.length > 1 && (this.frames[1]?.at ?? Number.POSITIVE_INFINITY) <= shown) {
      this.frames.shift();
    }
    return this.frames[0];
  }

  /** La dernière image reçue. */
  latest(): DatedFrame | undefined {
    return this.frames.at(-1);
  }

  /** Nombre d'images gardées. */
  get size(): number {
    return this.frames.length;
  }

  /** Oublie toutes les images (autre partie). */
  clear(): void {
    this.frames = [];
  }
}
