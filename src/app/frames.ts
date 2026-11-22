/**
 * Images et étapes datées (ADR 0013, ADR 0014) : ce que la carte montre des individus à
 * l'instant affiché par l'horloge du rendu (GameClock), et non au dernier état reçu.
 *
 * - Le worker envoie l'image des groupes quand elle change, au pas mensuel et après une
 *   commande : la position de chaque membre, qui le porte, et l'étape en cours de chaque
 *   marcheur, repartie de l'instant de l'image. Elle vaut à partir de l'instant de l'état
 *   qui la porte (FrameQueue) : apparitions, scissions, réunions, naissances et morts s'y
 *   voient à leur instant, en même temps que la date et les saisons.
 * - Avec chaque lot de jours, il envoie les étapes qui y commencent, chacune datée de son jour
 *   (LegQueue). Une étape attend dans la file que l'instant affiché atteigne son jour.
 * - Le miroir des positions (PositionMirror) tient, pour l'image de l'instant affiché, la
 *   position de chacun dans l'image et son étape en cours. À l'instant t, fractionnaire, un
 *   marcheur se tient en départ + pas × min(max(t − jour, 0), jours) (legAt) : aux jours
 *   entiers, à la position exacte du worker, par les mêmes additions entières ; entre deux,
 *   sur le segment du jour, que le worker a vérifié et qui ne coupe donc pas l'eau. En pause,
 *   l'instant s'arrête, et tout aussi ; changer de vitesse ne change rien aux étapes.
 * - Le nourrisson porté se tient contre sa mère, du côté que dit son identifiant, là où il se
 *   posera à son sevrage, comme le calcule le worker : rien ne saute quand il quitte ses bras.
 *
 * Les tampons lus retournent au worker (message `recycle`) : ceux d'une image quand la carte
 * ne la montre plus, ceux des étapes dès qu'elles sont toutes appliquées ou dépassées.
 */
import {
  GROUP_STRIDE,
  NO_CARRIER,
  type GroupsFrame,
  type HumanLegArrays,
  type LegArrays,
} from '../core/protocol';
import { cellOf, deltaFixedX, FIXED, wrapFixedX } from '../core/position';
import { dayIndex, type GameTime } from '../core/time';
import type { WorldSize } from '../core/world';
import { carriedOffset, type CrowdSource } from '../render/crowd';

/** Une image des groupes, et l'instant à partir duquel elle vaut. */
export interface DatedFrame {
  /** Instant, en jours écoulés depuis le début de la partie (dayIndex). */
  readonly at: number;
  readonly tick: number;
  readonly frame: GroupsFrame;
}

/** L'image `frame` d'un état de l'instant `time`. */
export function datedFrame(frame: GroupsFrame, time: GameTime): DatedFrame {
  return { at: dayIndex(time), tick: time.tick, frame };
}

/**
 * Images gardées au plus. Le retard de l'horloge reste bien en deçà (une image par mois et
 * par commande) ; la borne tient la mémoire d'un onglet en arrière-plan. L'horloge y avance
 * encore, à chaque état reçu, mais la carte ne s'y dessine plus : aucune image n'y est
 * demandée, et les images reçues s'entasseraient, comme les étapes, que la chronologie
 * oublie avec elles (CrowdTimeline.receive). Au retour de l'onglet, la première image
 * dessinée fait oublier toutes celles que l'horloge a dépassées.
 */
export const MAX_FRAMES = 16;

/**
 * File des images datées, de la plus ancienne encore utile à la dernière reçue. Une image
 * oubliée passe à `dropped`, qui rend ses tampons au worker (message `recycle`).
 */
export class FrameQueue {
  private frames: DatedFrame[] = [];
  private readonly dropped: (frame: GroupsFrame) => void;

  constructor(dropped: (frame: GroupsFrame) => void = () => undefined) {
    this.dropped = dropped;
  }

  private drop(frames: readonly DatedFrame[]): void {
    for (const dated of frames) this.dropped(dated.frame);
  }

  /** Instantané d'une partie : sa seule image. */
  reset(frame: GroupsFrame, time: GameTime): void {
    this.drop(this.frames);
    this.frames = [datedFrame(frame, time)];
  }

  /**
   * Une nouvelle image ; celle d'un même instant (commande en pause) remplace la précédente.
   * Renvoie vrai si la file, pleine, a oublié ses plus anciennes images.
   */
  push(frame: GroupsFrame, time: GameTime): boolean {
    const dated = datedFrame(frame, time);
    const last = this.frames.at(-1);
    if (last !== undefined && last.at >= dated.at) this.drop([this.frames.pop() ?? last]);
    this.frames.push(dated);
    if (this.frames.length <= MAX_FRAMES) return false;
    this.drop(this.frames.splice(0, this.frames.length - MAX_FRAMES));
    return true;
  }

  /** L'image de l'instant `shown` ; celles qu'il a dépassées s'oublient. */
  at(shown: number): DatedFrame | undefined {
    while (this.frames.length > 1 && (this.frames[1]?.at ?? Number.POSITIVE_INFINITY) <= shown) {
      this.drop(this.frames.splice(0, 1));
    }
    return this.frames[0];
  }

  /** La dernière image reçue. */
  latest(): DatedFrame | undefined {
    return this.frames.at(-1);
  }

  /** La plus ancienne image gardée, celle de l'instant affiché ou la première après lui. */
  oldest(): DatedFrame | undefined {
    return this.frames[0];
  }

  /** Nombre d'images gardées. */
  get size(): number {
    return this.frames.length;
  }

  /** Oublie toutes les images (autre partie). */
  clear(): void {
    this.drop(this.frames);
    this.frames = [];
  }
}

/**
 * Ce qui reçoit les étapes : le miroir des positions, ou la chronologie du gibier, qui lit en plus
 * l'allure de l'étape dans ses tableaux (`legs`, au rang `index`).
 */
export interface LegTarget<T extends LegArrays = LegArrays> {
  apply(
    slot: number,
    day: number,
    x: number,
    y: number,
    stepX: number,
    stepY: number,
    count: number,
    legs: T,
    index: number,
  ): void;
}

/** Étapes d'un delta, et le rang de la prochaine à appliquer. */
interface QueuedLegs<T extends LegArrays> {
  readonly legs: T;
  next: number;
}

/**
 * File des étapes reçues, dans l'ordre de leur arrivée, qui est celui de leurs jours : le
 * worker les note dans l'ordre où elles commencent, jour après jour. Une étape s'applique au
 * miroir quand l'instant affiché atteint son jour ; une image nouvelle fait oublier celles
 * qui partent avant son instant, qu'elle remplace par les étapes en cours qu'elle porte. Les
 * étapes d'un delta, toutes appliquées ou oubliées, passent à `dropped`, qui rend leurs
 * tampons au worker.
 */
export class LegQueue<T extends LegArrays = LegArrays> {
  private queue: QueuedLegs<T>[] = [];
  private readonly dropped: (legs: T) => void;

  constructor(dropped: (legs: T) => void = () => undefined) {
    this.dropped = dropped;
  }

  /** Les étapes d'un delta. */
  push(legs: T): void {
    if (legs.slots.length === 0) this.dropped(legs);
    else this.queue.push({ legs, next: 0 });
  }

  /** Oublie les étapes parties avant le jour `day` : une image de cet instant les remplace. */
  dropBefore(day: number): void {
    this.consume((days, index) => (days[index] ?? 0) < day);
  }

  /**
   * Applique à `target`, dans l'ordre de leur arrivée, les étapes parties à l'instant `t` au
   * plus tard. Une étape d'un même jour qu'une autre la remplace : c'est un écart de côté.
   */
  applyUntil(t: number, target: LegTarget<T>): void {
    this.consume((days, index, legs) => {
      if ((days[index] ?? 0) > t) return false;
      target.apply(
        legs.slots[index] ?? 0,
        days[index] ?? 0,
        legs.start[2 * index] ?? 0,
        legs.start[2 * index + 1] ?? 0,
        legs.step[2 * index] ?? 0,
        legs.step[2 * index + 1] ?? 0,
        legs.count[index] ?? 0,
        legs,
        index,
      );
      return true;
    });
  }

  /**
   * Passe à `target`, dans l'ordre de leur arrivée et sans les ôter de la file, les étapes en
   * attente parties au jour `from` au plus tôt.
   */
  forEachFrom(from: number, target: LegTarget<T>): void {
    for (const { legs, next } of this.queue) {
      const { days } = legs;
      for (let index = next; index < days.length; index++) {
        if ((days[index] ?? 0) < from) continue;
        target.apply(
          legs.slots[index] ?? 0,
          days[index] ?? 0,
          legs.start[2 * index] ?? 0,
          legs.start[2 * index + 1] ?? 0,
          legs.step[2 * index] ?? 0,
          legs.step[2 * index + 1] ?? 0,
          legs.count[index] ?? 0,
          legs,
          index,
        );
      }
    }
  }

  /** Passe les étapes, dans l'ordre, tant que `take` les prend. */
  private consume(take: (days: Uint32Array, index: number, legs: T) => boolean): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const { days } = head.legs;
      while (head.next < days.length && take(days, head.next, head.legs)) head.next++;
      if (head.next < days.length) return;
      this.queue.shift();
      this.dropped(head.legs);
    }
  }

  /** Étapes en attente. */
  get size(): number {
    return this.queue.reduce((sum, queued) => sum + queued.legs.slots.length - queued.next, 0);
  }

  /** Oublie toutes les étapes (autre partie). */
  clear(): void {
    for (const queued of this.queue) this.dropped(queued.legs);
    this.queue = [];
  }
}

/** Ce que le miroir doit savoir des données et du monde. */
export interface MirrorOptions {
  /** Écart d'un nourrisson porté à sa mère, en cases (display.carry de data/species.json). */
  readonly carry: number;
  /** La case, comptée comme cellIndex, se franchit-elle ? */
  readonly passable: (cell: number) => boolean;
}

/** Valeurs par groupe dans PositionMirror.box : origine, écarts ouest et est, y haut et bas. */
const BOX_STRIDE = 5;
/** Une position, en unités, réutilisée. */
const placed = new Float64Array(2);

/**
 * Miroir des positions de l'image d'un instant (ADR 0014) : pour chaque membre, sa position de
 * l'image et son étape en cours, la dernière reçue de celles qui sont parties. Il donne la
 * position de chacun à tout instant de l'image, et, pour chaque groupe, ce que ses membres
 * peuvent atteindre : la carte n'interpole que les groupes que l'écran peut montrer.
 */
export class PositionMirror implements CrowdSource {
  frame: GroupsFrame | undefined;
  /** Instant de l'image, en jours (dayIndex). */
  at = 0;
  width = 1;
  groupCount = 0;
  firsts = new Uint32Array(0);
  sizes = new Uint32Array(0);
  carrierOf = new Int32Array(0);
  firstCarried = new Int32Array(0);
  nextCarried = new Int32Array(0);
  /** Rang dans l'image de chaque emplacement, −1 hors de l'image. */
  private memberOf = new Int32Array(0);
  /** Rang du groupe de chaque membre. */
  private groupOf = new Uint32Array(0);
  /** Étape en cours de chaque membre : son jour (NaN sans étape), départ, pas et jours. */
  private legDay = new Float64Array(0);
  private legX = new Float64Array(0);
  private legY = new Float64Array(0);
  private stepX = new Float64Array(0);
  private stepY = new Float64Array(0);
  private legCount = new Uint16Array(0);
  /**
   * Sens de chaque membre, −1 vers l'ouest, 1 vers l'est, 0 inconnu : celui du dernier pas
   * horizontal de ses étapes, gardé d'une image des groupes à l'autre pour qui reste le même
   * (même emplacement, même identifiant), si bien qu'un individu arrêté ne se retourne pas au
   * pas mensuel (2b.5). Deux tableaux, pour reprendre l'un dans l'autre.
   */
  private facingOf = new Int8Array(0);
  private facingSpare = new Int8Array(0);
  /** Ce que peuvent atteindre les membres de chaque groupe (BOX_STRIDE valeurs). */
  private box = new Float64Array(0);
  private readonly carry: number;
  private readonly passable: (cell: number) => boolean;
  /** Étapes appliquées depuis l'image. */
  applied = 0;

  constructor(options: MirrorOptions) {
    this.carry = options.carry;
    this.passable = options.passable;
  }

  /** L'image `dated`, sur un monde de `width` colonnes, avec les étapes en cours qu'elle porte. */
  reset(dated: DatedFrame | undefined, width: number): void {
    const previous = this.frame;
    const frame = dated?.frame;
    this.keepFacing(previous, frame);
    this.frame = frame;
    this.at = dated?.at ?? 0;
    this.width = width;
    this.applied = 0;
    const count = frame?.ids.length ?? 0;
    if (this.legDay.length < count) {
      const size = Math.max(count, this.legDay.length * 2);
      this.groupOf = new Uint32Array(size);
      this.carrierOf = new Int32Array(size);
      this.firstCarried = new Int32Array(size);
      this.nextCarried = new Int32Array(size);
      this.legDay = new Float64Array(size);
      this.legX = new Float64Array(size);
      this.legY = new Float64Array(size);
      this.stepX = new Float64Array(size);
      this.stepY = new Float64Array(size);
      this.legCount = new Uint16Array(size);
    }
    this.memberOf.fill(-1);
    if (frame === undefined) {
      this.groupCount = 0;
      return;
    }
    const { slots, positions, carriers, groups } = frame;
    let largest = -1;
    for (let member = 0; member < count; member++) largest = Math.max(largest, slots[member] ?? 0);
    if (this.memberOf.length <= largest) {
      this.memberOf = new Int32Array(Math.max(largest + 1, this.memberOf.length * 2)).fill(-1);
    }
    for (let member = 0; member < count; member++) this.memberOf[slots[member] ?? 0] = member;
    // Les groupes, leurs membres et ce qu'ils occupent dans l'image.
    const groupCount = Math.floor(groups.length / GROUP_STRIDE);
    this.groupCount = groupCount;
    if (this.firsts.length < groupCount) {
      const size = Math.max(groupCount, this.firsts.length * 2);
      this.firsts = new Uint32Array(size);
      this.sizes = new Uint32Array(size);
      this.box = new Float64Array(size * BOX_STRIDE);
    }
    let first = 0;
    for (let group = 0; group < groupCount; group++) {
      const size = Math.min(groups[group * GROUP_STRIDE + 3] ?? 0, count - first);
      this.firsts[group] = first;
      this.sizes[group] = size;
      const origin = positions[2 * first] ?? 0;
      const at = group * BOX_STRIDE;
      this.box[at] = origin;
      this.box[at + 1] = 0;
      this.box[at + 2] = 0;
      this.box[at + 3] = Number.POSITIVE_INFINITY;
      this.box[at + 4] = Number.NEGATIVE_INFINITY;
      for (let member = first; member < first + size; member++) {
        this.groupOf[member] = group;
        this.include(group, positions[2 * member] ?? 0, positions[2 * member + 1] ?? 0);
      }
      first += size;
    }
    // Les portés : chacun contre sa mère, qui marche dans le même groupe.
    this.firstCarried.fill(-1, 0, count);
    this.nextCarried.fill(-1, 0, count);
    for (let member = count - 1; member >= 0; member--) {
      const slot = carriers[member] ?? NO_CARRIER;
      const mother = slot === NO_CARRIER ? -1 : (this.memberOf[slot] ?? -1);
      const valid =
        mother >= 0 &&
        mother !== member &&
        this.groupOf[mother] === this.groupOf[member] &&
        (carriers[mother] ?? NO_CARRIER) === NO_CARRIER;
      this.carrierOf[member] = valid ? mother : -1;
      if (!valid) continue;
      this.nextCarried[member] = this.firstCarried[mother] ?? -1;
      this.firstCarried[mother] = member;
    }
    // Les étapes en cours, reparties de l'instant de l'image.
    this.legDay.fill(Number.NaN, 0, count);
    const { legs } = frame;
    for (let index = 0; index < legs.slots.length; index++) {
      this.apply(
        legs.slots[index] ?? 0,
        legs.days[index] ?? 0,
        legs.start[2 * index] ?? 0,
        legs.start[2 * index + 1] ?? 0,
        legs.step[2 * index] ?? 0,
        legs.step[2 * index + 1] ?? 0,
        legs.count[index] ?? 0,
      );
    }
  }

  /**
   * Reprend dans la nouvelle image `frame` le sens de chacun de l'image `previous` : avant que
   * memberOf ne passe à la nouvelle, il dit encore le rang de chaque emplacement dans l'ancienne.
   */
  private keepFacing(previous: GroupsFrame | undefined, frame: GroupsFrame | undefined): void {
    const count = frame?.ids.length ?? 0;
    let next = this.facingSpare;
    if (next.length < count) next = new Int8Array(Math.max(count, next.length * 2));
    next.fill(0, 0, count);
    if (previous !== undefined && frame !== undefined && previous !== frame) {
      const { slots, ids } = frame;
      for (let member = 0; member < count; member++) {
        const slot = slots[member] ?? 0;
        const before = this.memberOf[slot] ?? -1;
        if (before >= 0 && previous.ids[before] === ids[member]) {
          next[member] = this.facingOf[before] ?? 0;
        }
      }
    } else if (previous === frame) {
      next.set(this.facingOf.subarray(0, count));
    }
    this.facingSpare = this.facingOf;
    this.facingOf = next;
  }

  /** Étend la boîte du groupe au point (x, y), en unités. */
  private include(group: number, x: number, y: number): void {
    const at = group * BOX_STRIDE;
    const dx = deltaFixedX(this.box[at] ?? 0, x, this.width);
    if (dx < (this.box[at + 1] ?? 0)) this.box[at + 1] = dx;
    if (dx > (this.box[at + 2] ?? 0)) this.box[at + 2] = dx;
    if (y < (this.box[at + 3] ?? 0)) this.box[at + 3] = y;
    if (y > (this.box[at + 4] ?? 0)) this.box[at + 4] = y;
  }

  /**
   * Une étape de l'emplacement `slot`, partie au jour `day` du point (x, y), qui avance de
   * (stepX, stepY) par jour pendant `count` jours : elle remplace l'étape en cours. Un
   * emplacement hors de l'image est ignoré.
   */
  apply(
    slot: number,
    day: number,
    x: number,
    y: number,
    stepX: number,
    stepY: number,
    count: number,
  ): void {
    const member = this.memberOf[slot] ?? -1;
    if (member < 0) return;
    this.applied++;
    this.legDay[member] = day;
    this.legX[member] = x;
    this.legY[member] = y;
    this.stepX[member] = stepX;
    this.stepY[member] = stepY;
    this.legCount[member] = count;
    const group = this.groupOf[member] ?? 0;
    this.include(group, x, y);
    this.include(group, wrapFixedX(x + stepX * count, this.width), y + stepY * count);
  }

  /**
   * Reprend les étapes en cours de `other`, un miroir de la même image : celles qu'il a
   * appliquées depuis elle.
   */
  adoptLegs(other: PositionMirror): void {
    if (other.frame !== this.frame || this.frame === undefined) return;
    const count = this.frame.ids.length;
    this.legDay.set(other.legDay.subarray(0, count));
    this.legX.set(other.legX.subarray(0, count));
    this.legY.set(other.legY.subarray(0, count));
    this.stepX.set(other.stepX.subarray(0, count));
    this.stepY.set(other.stepY.subarray(0, count));
    this.legCount.set(other.legCount.subarray(0, count));
    if (this.facingOf.length < count) this.facingOf = new Int8Array(count);
    this.facingOf.set(other.facingOf.subarray(0, count));
    this.box.set(other.box.subarray(0, this.groupCount * BOX_STRIDE));
    this.applied = other.applied;
  }

  bounds(group: number, out: Float64Array): void {
    const at = group * BOX_STRIDE;
    const reach = Math.abs(carriedOffset(1, this.carry));
    out[0] = this.box[at] ?? 0;
    out[1] = (this.box[at + 1] ?? 0) - reach;
    out[2] = (this.box[at + 2] ?? 0) + reach;
    out[3] = this.box[at + 3] ?? 0;
    out[4] = this.box[at + 4] ?? 0;
  }

  /**
   * Position du membre `member`, qui n'est pas porté, à l'instant `t` : x (ramené dans le
   * monde) et y dans `placed`, en unités ; renvoie vrai s'il est en marche sur une étape.
   */
  private place(member: number, t: number): boolean {
    const day = this.legDay[member] ?? Number.NaN;
    if (Number.isNaN(day)) {
      placed[0] = this.frame?.positions[2 * member] ?? 0;
      placed[1] = this.frame?.positions[2 * member + 1] ?? 0;
      return false;
    }
    // legAt : départ + pas × min(max(t − jour, 0), jours), exact aux jours entiers.
    const elapsed = t - day;
    const count = this.legCount[member] ?? 0;
    const done = elapsed <= 0 ? 0 : elapsed >= count ? count : elapsed;
    const span = this.width * FIXED;
    let x = (this.legX[member] ?? 0) + (this.stepX[member] ?? 0) * done;
    x %= span;
    if (x < 0) x += span;
    placed[0] = x;
    placed[1] = (this.legY[member] ?? 0) + (this.stepY[member] ?? 0) * done;
    return elapsed > 0 && elapsed < count;
  }

  /**
   * Écart à sa mère du nourrisson porté `member` quand elle se tient en (x, y), en unités :
   * du côté que dit son identifiant, à display.carry cases d'elle, si la case de ce point se
   * franchit, comme le pose le worker à son sevrage ; nul sinon.
   */
  private carriedAt(member: number, x: number, y: number): number {
    const offset = carriedOffset(this.frame?.ids[member] ?? 0, this.carry);
    return this.passable(cellOf(wrapFixedX(x + offset, this.width), y, this.width)) ? offset : 0;
  }

  positions(
    group: number,
    t: number,
    xs: Float64Array,
    ys: Float64Array,
    moving: Uint8Array,
    facing?: Int8Array,
  ) {
    if (this.frame === undefined) return;
    const first = this.firsts[group] ?? 0;
    const end = first + (this.sizes[group] ?? 0);
    for (let member = first; member < end; member++) {
      if ((this.carrierOf[member] ?? -1) >= 0) continue;
      moving[member] = this.place(member, t) ? 1 : 0;
      xs[member] = placed[0];
      ys[member] = placed[1];
      // Son sens : celui du pas horizontal de son étape, en cours ou finie ; sans étape, ou
      // sur un pas vertical, celui qu'il avait, gardé d'une image des groupes à l'autre.
      if (facing !== undefined) {
        const step = Number.isNaN(this.legDay[member] ?? Number.NaN)
          ? 0
          : (this.stepX[member] ?? 0);
        if (step !== 0) this.facingOf[member] = step > 0 ? 1 : -1;
        facing[member] = this.facingOf[member] ?? 0;
      }
    }
    // Les portés, contre leur mère. Leur écart se décide aux jours entiers, aux positions de
    // leur mère, comme le worker au sevrage, et passe d'un jour à l'autre sans saut : il
    // s'efface en un jour quand elle longe l'eau. Si ce passage frôle un coin d'eau, l'écart
    // se resserre vers elle, dont la case se franchit toujours.
    const day = Math.floor(t);
    const part = t - day;
    for (let member = first; member < end; member++) {
      const mother = this.carrierOf[member] ?? -1;
      if (mother < 0) continue;
      const mx = xs[mother] ?? 0;
      const my = ys[mother] ?? 0;
      let offset: number;
      if (part === 0) {
        offset = this.carriedAt(member, mx, my);
      } else {
        this.place(mother, day);
        const before = this.carriedAt(member, placed[0], placed[1]);
        this.place(mother, day + 1);
        const after = this.carriedAt(member, placed[0], placed[1]);
        offset = before + (after - before) * part;
        for (let tries = 0; tries < 2 && offset !== 0; tries++) {
          const x = wrapFixedX(mx + offset, this.width);
          if (this.passable(cellOf(x, my, this.width))) break;
          offset = tries === 0 ? offset / 2 : 0;
        }
      }
      xs[member] = wrapFixedX(mx + offset, this.width);
      ys[member] = my;
      moving[member] = 0;
    }
  }

  /** Cases où se tient quelqu'un à l'instant `t`, comptées comme cellIndex. */
  cells(t: number, size: WorldSize, into = new Set<number>()): Set<number> {
    const count = this.frame?.ids.length ?? 0;
    const xs = new Float64Array(count);
    const ys = new Float64Array(count);
    const moving = new Uint8Array(count);
    for (let group = 0; group < this.groupCount; group++) {
      this.positions(group, t, xs, ys, moving);
    }
    for (let member = 0; member < count; member++) {
      const y = ys[member] ?? 0;
      if (y < 0 || y >= size.height * FIXED) continue;
      into.add(cellOf(wrapFixedX(xs[member] ?? 0, size.width), y, size.width));
    }
    return into;
  }
}

/** Ce que demande la chronologie des individus. */
export interface TimelineOptions extends MirrorOptions {
  /** Une image que la carte ne montre plus : ses tampons retournent au worker. */
  readonly recycleFrame?: (frame: GroupsFrame) => void;
  /** Des étapes lues ou dépassées : leurs tampons retournent au worker, octets d'activité compris. */
  readonly recycleLegs?: (legs: HumanLegArrays) => void;
}

/**
 * Chronologie des individus : les images et les étapes datées, et le miroir de l'instant
 * affiché (`shown`). Le dernier état reçu, que suit l'outil d'apparition, ne se calcule qu'à
 * sa demande (occupied) : rien ne le tient au fil des messages, qui ne coûtent donc rien par
 * membre.
 */
export class CrowdTimeline {
  readonly frames: FrameQueue;
  readonly legs: LegQueue<HumanLegArrays>;
  /** Positions à l'instant affiché. */
  readonly shown: PositionMirror;
  /**
   * Positions au dernier état reçu, à son instant (`latestAt`) : occupied() le remplit, le
   * lit, puis le vide ; il ne garde donc aucune image.
   */
  readonly latest: PositionMirror;
  latestAt = 0;
  private shownFrame: DatedFrame | undefined;
  private width = 1;
  /** Images oubliées par la file que le miroir lit encore : rendues dès qu'il les quitte. */
  private held: GroupsFrame[] = [];
  private readonly recycleFrame: (frame: GroupsFrame) => void;

  constructor(options: TimelineOptions) {
    this.recycleFrame = options.recycleFrame ?? (() => undefined);
    this.frames = new FrameQueue((frame) => {
      if (frame === this.shown.frame) this.held.push(frame);
      else this.recycleFrame(frame);
    });
    this.legs = new LegQueue<HumanLegArrays>(options.recycleLegs);
    this.shown = new PositionMirror(options);
    this.latest = new PositionMirror(options);
  }

  /** Instantané d'une partie, à l'instant `time`, sur un monde de `width` colonnes. */
  reset(frame: GroupsFrame, time: GameTime, width: number): void {
    this.width = width;
    this.legs.clear();
    this.frames.reset(frame, time);
    this.latestAt = dayIndex(time);
    this.show(this.latestAt);
  }

  /**
   * Un delta de l'instant `time` : les étapes commencées pendant ses jours, et son image s'il
   * en porte une, qui vaut à partir de cet instant.
   */
  receive(time: GameTime, legs: HumanLegArrays | undefined, frame: GroupsFrame | undefined): void {
    if (legs !== undefined) this.legs.push(legs);
    if (frame !== undefined && this.frames.push(frame, time)) {
      // La file, pleine, a oublié des images que la carte n'a pas montrées : elle ne se
      // dessine plus (onglet en arrière-plan). Les étapes parties avant la plus ancienne
      // image gardée ne serviront pas : show() les oublierait en la prenant. Sans quoi elles
      // s'entasseraient, sans borne.
      this.legs.dropBefore(this.frames.oldest()?.at ?? 0);
    }
    this.latestAt = Math.max(this.latestAt, dayIndex(time));
  }

  /**
   * L'instant affiché `t`, en jours : le miroir prend l'image de cet instant, puis les étapes
   * parties depuis elle, jusqu'à lui.
   */
  show(t: number): void {
    const dated = this.frames.at(t);
    if (dated !== this.shownFrame) {
      this.shownFrame = dated;
      this.shown.reset(dated, this.width);
      if (dated !== undefined) this.legs.dropBefore(dated.at);
      this.release();
    }
    this.legs.applyUntil(t, this.shown);
  }

  /** Rend au worker les images oubliées que le miroir ne lit plus. */
  private release(): void {
    const kept: GroupsFrame[] = [];
    for (const frame of this.held) {
      if (frame === this.shown.frame) kept.push(frame);
      else this.recycleFrame(frame);
    }
    this.held = kept;
  }

  /**
   * Cases où se tient quelqu'un, à l'instant affiché `t` et au dernier état reçu. Celui-ci se
   * calcule ici : la dernière image reçue, les étapes que le miroir de l'instant affiché en a
   * déjà appliquées s'il la montre, puis celles de la file parties depuis elle.
   */
  occupied(t: number, size: WorldSize): Set<number> {
    const into = this.shown.cells(t, size);
    const dated = this.frames.latest();
    if (dated === undefined) return into;
    this.latest.reset(dated, this.width);
    if (dated === this.shownFrame) this.latest.adoptLegs(this.shown);
    this.legs.forEachFrom(dated.at, this.latest);
    this.latest.cells(this.latestAt, size, into);
    this.latest.reset(undefined, this.width);
    return into;
  }

  /** Autre partie : plus d'image ni d'étape. */
  clear(): void {
    this.legs.clear();
    this.frames.clear();
    this.shownFrame = undefined;
    this.shown.reset(undefined, this.width);
    this.release();
  }
}
