/**
 * Le gibier à l'instant affiché (tâche 2b.6, ADR 0018), comme les individus (frames.ts, ADR 0014) :
 * une image du gibier vaut à partir de l'instant de l'état qui la porte (au pas mensuel, naissances
 * et morts s'y voient à leur instant), et les étapes de chaque delta attendent leur jour dans une
 * file (LegQueue). À l'instant t, un animal en route se tient en départ + pas × min(max(t − jour,
 * 0), jours) : aux jours entiers, à la position exacte du worker ; entre deux, sur le segment du
 * jour, que le worker a vérifié. Une étape de zéro jour l'arrête à son départ ; une étape du même
 * jour qu'une autre la remplace. Son allure est celle que l'état donne à l'étape (protocole 7),
 * jamais sa vitesse apparente. En pause, l'instant s'arrête, et tout avec lui.
 *
 * Les animaux d'une image qui manquent à la suivante sont morts entre les deux (vieillesse,
 * excès sur la cible) : la chronologie les garde, à leur dernière position, pour que le rendu
 * les montre tomber (`fallen`), au lieu de les effacer d'un coup.
 */
import { FAUNA_GAIT, FAUNA_RUN, type FaunaFrame, type FaunaLegArrays } from '../core/protocol';
import { legAt, wrapFixedX } from '../core/position';
import { dayIndex, type GameTime } from '../core/time';
import { LegQueue, MAX_FRAMES } from './frames';

/** Ce que le rendu lit du gibier : l'image de l'instant, et la position et l'allure de chacun. */
export interface FaunaSource {
  readonly frame: FaunaFrame | undefined;
  /** Change dès qu'une image ou une étape s'applique : la signature du calque le lit. */
  readonly version: number;
  /** Les animaux morts à la dernière image : position, sorte, sens, identifiant, et leur instant. */
  readonly fallen: FallenAnimals;
  /** Position du i-ième animal de l'image à l'instant t, en unités, x dans le monde. */
  position(index: number, t: number, out: Float64Array): void;
  /** Allure du i-ième animal à l'instant t : au repos, au pas ou au galop (FAUNA_GAIT). */
  gait(index: number, t: number): number;
  /** Sens de sa dernière étape connue : −1 vers l'ouest, 1 vers l'est, 0 sans étape. */
  facing(index: number): number;
}

/** Des animaux morts entre deux images, à montrer tombant. */
export interface FallenAnimals {
  count: number;
  /** Instant de l'image qui ne les porte plus, en jours. */
  at: number;
  /** Génération : elle change à chaque image qui en apporte. */
  generation: number;
  ids: Uint32Array;
  kinds: Uint8Array;
  positions: Int32Array;
  facing: Int8Array;
}

function emptyFallen(): FallenAnimals {
  return {
    count: 0,
    at: 0,
    generation: 0,
    ids: new Uint32Array(0),
    kinds: new Uint8Array(0),
    positions: new Int32Array(0),
    facing: new Int8Array(0),
  };
}

export class FaunaTimeline implements FaunaSource {
  frame: FaunaFrame | undefined;
  /** Instant de l'image en cours, en jours. */
  at = 0;
  version = 0;
  fallen: FallenAnimals = emptyFallen();
  private width = 1;
  private pending: { at: number; frame: FaunaFrame }[] = [];
  readonly legs: LegQueue<FaunaLegArrays>;
  private readonly dropFrame: (frame: FaunaFrame) => void;
  /** Rang dans l'image de chaque emplacement, −1 s'il n'y est pas. */
  private indexOf = new Int32Array(0);
  /** L'étape qui vaut pour chaque rang de l'image : son jour (NaN sans étape), départ, pas, jours, allure. */
  private legDay = new Float64Array(0);
  private legX = new Int32Array(0);
  private legY = new Int32Array(0);
  private stepX = new Int32Array(0);
  private stepY = new Int32Array(0);
  private legCount = new Uint16Array(0);
  private legGait = new Uint8Array(0);
  private facingOf = new Int8Array(0);
  private readonly point = new Float64Array(2);

  constructor(
    dropLegs: (legs: FaunaLegArrays) => void,
    dropFrame: (frame: FaunaFrame) => void = () => undefined,
  ) {
    this.legs = new LegQueue<FaunaLegArrays>(dropLegs);
    this.dropFrame = dropFrame;
  }

  /** Une partie commence : son image du gibier, à l'instant `time`, sur un monde de `width` colonnes. */
  reset(frame: FaunaFrame, time: GameTime, width: number): void {
    this.legs.clear();
    for (const queued of this.pending) this.dropFrame(queued.frame);
    this.pending = [];
    if (this.frame !== undefined) this.dropFrame(this.frame);
    this.frame = undefined;
    this.width = width;
    this.fallen = emptyFallen();
    this.adopt(frame, dayIndex(time), false);
  }

  /** Ce qu'apporte un delta : les étapes du lot, et l'image du gibier si elle a changé. */
  receive(time: GameTime, legs: FaunaLegArrays | undefined, frame: FaunaFrame | undefined): void {
    if (legs !== undefined) this.legs.push(legs);
    if (frame === undefined) return;
    this.pending.push({ at: dayIndex(time), frame });
    // Une file bornée, comme celle des images des groupes : les plus anciennes s'oublient.
    while (this.pending.length > MAX_FRAMES) {
      const dropped = this.pending.shift();
      if (dropped !== undefined) this.dropFrame(dropped.frame);
    }
  }

  /** L'instant affiché devient `t` : les images et les étapes parties d'ici là s'appliquent. */
  show(t: number): void {
    let latest: { at: number; frame: FaunaFrame } | undefined;
    while (this.pending.length > 0 && (this.pending[0]?.at ?? Number.POSITIVE_INFINITY) <= t) {
      if (latest !== undefined) this.dropFrame(latest.frame);
      latest = this.pending.shift();
    }
    if (latest !== undefined) {
      this.adopt(latest.frame, latest.at, true);
      this.legs.dropBefore(latest.at);
    }
    this.legs.applyUntil(t, this);
  }

  /** Images en attente (essais, panneau de débogage). */
  get queued(): number {
    return this.pending.length;
  }

  private adopt(frame: FaunaFrame, at: number, keep: boolean): void {
    const previous = this.frame;
    const n = frame.ids.length;
    // Le sens de chacun, gardé d'une image à l'autre pour le même animal (emplacement et
    // identifiant) ; ceux qui manquent à la nouvelle sont morts, à montrer tombant.
    const facing = new Int8Array(n);
    let top = 0;
    for (const slot of frame.slots) top = Math.max(top, slot + 1);
    const indexOf = new Int32Array(Math.max(top, 1)).fill(-1);
    frame.slots.forEach((slot, index) => (indexOf[slot] = index));
    if (previous !== undefined && keep) {
      for (let index = 0; index < n; index++) {
        const slot = frame.slots[index] ?? 0;
        const before = slot < this.indexOf.length ? (this.indexOf[slot] ?? -1) : -1;
        if (before >= 0 && previous.ids[before] === frame.ids[index]) {
          facing[index] = this.facingOf[before] ?? 0;
        }
      }
      this.collectFallen(previous, frame, indexOf, at);
    }
    if (previous !== undefined) this.dropFrame(previous);
    this.frame = frame;
    this.at = at;
    this.facingOf = facing;
    this.indexOf = indexOf;
    this.legDay = new Float64Array(n).fill(Number.NaN);
    this.legX = new Int32Array(n);
    this.legY = new Int32Array(n);
    this.stepX = new Int32Array(n);
    this.stepY = new Int32Array(n);
    this.legCount = new Uint16Array(n);
    this.legGait = new Uint8Array(n);
    const { legs } = frame;
    for (let leg = 0; leg < legs.slots.length; leg++) {
      const slot = legs.slots[leg] ?? 0;
      const index = slot < indexOf.length ? (indexOf[slot] ?? -1) : -1;
      if (index < 0) continue;
      this.set(
        index,
        legs.days[leg] ?? 0,
        legs.start[2 * leg] ?? 0,
        legs.start[2 * leg + 1] ?? 0,
        legs.step[2 * leg] ?? 0,
        legs.step[2 * leg + 1] ?? 0,
        legs.count[leg] ?? 0,
        ((frame.kinds[index] ?? 0) & FAUNA_RUN) !== 0 ? FAUNA_GAIT.run : FAUNA_GAIT.walk,
      );
    }
    this.version++;
  }

  /** Les animaux de `previous` absents de `next`, à leur position de l'instant `at`. */
  private collectFallen(
    previous: FaunaFrame,
    next: FaunaFrame,
    indexOf: Int32Array,
    at: number,
  ): void {
    const gone: number[] = [];
    previous.slots.forEach((slot, before) => {
      const index = slot < indexOf.length ? (indexOf[slot] ?? -1) : -1;
      if (index < 0 || next.ids[index] !== previous.ids[before]) gone.push(before);
    });
    if (gone.length === 0) return;
    const fallen: FallenAnimals = {
      count: gone.length,
      at,
      generation: this.fallen.generation + 1,
      ids: new Uint32Array(gone.length),
      kinds: new Uint8Array(gone.length),
      positions: new Int32Array(2 * gone.length),
      facing: new Int8Array(gone.length),
    };
    gone.forEach((before, rank) => {
      this.position(before, at, this.point);
      fallen.ids[rank] = previous.ids[before] ?? 0;
      fallen.kinds[rank] = (previous.kinds[before] ?? 0) & ~FAUNA_RUN;
      fallen.positions[2 * rank] = this.point[0];
      fallen.positions[2 * rank + 1] = this.point[1];
      fallen.facing[rank] = this.facingOf[before] ?? 0;
    });
    this.fallen = fallen;
  }

  /** Une étape reçue d'un delta (LegQueue) : celle de l'emplacement `slot`, si l'image le porte. */
  apply(
    slot: number,
    day: number,
    x: number,
    y: number,
    sx: number,
    sy: number,
    count: number,
    legs: FaunaLegArrays,
    index: number,
  ): void {
    const at = slot < this.indexOf.length ? (this.indexOf[slot] ?? -1) : -1;
    if (at < 0) return;
    this.set(at, day, x, y, sx, sy, count, legs.gaits[index] ?? FAUNA_GAIT.walk);
    this.version++;
  }

  private set(
    index: number,
    day: number,
    x: number,
    y: number,
    sx: number,
    sy: number,
    count: number,
    gait: number,
  ): void {
    this.legDay[index] = day;
    this.legX[index] = x;
    this.legY[index] = y;
    this.stepX[index] = sx;
    this.stepY[index] = sy;
    this.legCount[index] = count;
    this.legGait[index] = count === 0 ? FAUNA_GAIT.rest : gait;
    if (sx !== 0 && count > 0) this.facingOf[index] = sx > 0 ? 1 : -1;
  }

  position(index: number, t: number, out: Float64Array): void {
    const frame = this.frame;
    if (frame === undefined) return;
    const day = this.legDay[index] ?? Number.NaN;
    if (Number.isNaN(day)) {
      out[0] = frame.positions[2 * index] ?? 0;
      out[1] = frame.positions[2 * index + 1] ?? 0;
      return;
    }
    const count = this.legCount[index] ?? 0;
    const since = t - day;
    out[0] = wrapFixedX(
      Math.round(legAt(this.legX[index] ?? 0, this.stepX[index] ?? 0, count, since)),
      this.width,
    );
    out[1] = Math.round(legAt(this.legY[index] ?? 0, this.stepY[index] ?? 0, count, since));
  }

  gait(index: number, t: number): number {
    const day = this.legDay[index] ?? Number.NaN;
    if (Number.isNaN(day)) return FAUNA_GAIT.rest;
    const since = t - day;
    if (since < 0 || since >= (this.legCount[index] ?? 0)) return FAUNA_GAIT.rest;
    return this.legGait[index] ?? FAUNA_GAIT.walk;
  }

  facing(index: number): number {
    return this.facingOf[index] ?? 0;
  }
}
