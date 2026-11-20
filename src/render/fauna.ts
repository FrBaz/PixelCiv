/**
 * Le gibier sur la carte (tâche 2b.6 ; FAU-01, REN-03, REN-08, REN-09 ; ADR 0018, § 4).
 *
 * Chaque animal visible est une particule du conteneur des humains (people.ts), une source
 * d'objets du calque commun (objects.ts, ADR 0017 § 7) : au niveau de motifs et à la densité k de
 * la vue, ses motifs dans l'atlas des rôles sous ceux des humains et du décor, sa palette dans la
 * même texture, aux clés du gibier, trié avec humains et décor par ses pieds, et retourné vers
 * l'est autour de son bord droit. Il n'a pas d'ombre portée, comme les humains : tous ses pixels
 * peints cachent, à l'appui, ce qui est derrière lui. Il ne se choisit pas.
 *
 * Sa position vient de l'état du worker, à l'instant affiché (app/faunaFrames.ts). Son image est
 * une fonction pure de son allure, que l'état donne à son étape (protocole 7), de son identifiant
 * et de l'horloge de la marche du rendu, figée en pause : au galop la course, au pas la marche,
 * au repos un cycle où il se tient debout, bouge l'oreille ou la queue, puis broute. Un animal mort
 * entre deux images du gibier tombe là où il était, puis disparaît.
 */
import faunaAtlas from 'virtual:fauna-atlas';
import type { Catalog } from '../core/data/catalog';
import type { FaunaRules, FaunaSpecies } from '../core/data/fauna';
import { PALETTE_ROLES } from '../core/data/humans';
import { FIXED } from '../core/position';
import {
  FAUNA_GAIT,
  FAUNA_MALE,
  FAUNA_SPECIES,
  FAUNA_YOUNG,
  type FaunaFrame,
} from '../core/protocol';
import { splitmix32 } from '../core/rng';
import { FAUNA_LEGEND, FAUNA_REGIONS, legendRole } from '../gen/legend';
import { parseColor } from './bake';
import { TILE_PX } from './camera';
import {
  OBJECT_FLAG,
  ObjectList,
  PALETTE_KEYS,
  type ObjectAtlas,
  type ObjectColor,
  type ObjectPalette,
  type ObjectSource,
  type ObjectView,
  type PaletteSlots,
} from './objects';

/** Rôles d'un atlas en base64, un octet par pixel, décodés une fois. */
function decodeRoles(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/** L'atlas du gibier, rangé au build (tools/fauna-atlas.ts) : pas de rôles d'ombre. */
export const FAUNA_ATLAS: ObjectAtlas = {
  width: faunaAtlas.width,
  height: faunaAtlas.height,
  roles: decodeRoles(faunaAtlas.roles),
  motifs: faunaAtlas.motifs,
};
export const FAUNA_FORMS = faunaAtlas.forms;

/** Rang de chaque animation dans l'atlas. */
export const FAUNA_ANIMATION = {
  idle: faunaAtlas.animations.indexOf('idle'),
  walk: faunaAtlas.animations.indexOf('walk'),
  run: faunaAtlas.animations.indexOf('run'),
  fall: faunaAtlas.animations.indexOf('fall'),
} as const;

const TWO_POW_32 = 4294967296;

/**
 * Phase propre d'un animal, dans [0, 1[, tirée de son identifiant (splitmix32, crédité) : le second
 * tirage de sa suite, le premier donnant son allure propre dans la simulation (sim/fauna.ts).
 */
export function phaseOf(id: number): number {
  const next = splitmix32(id);
  next();
  return next() / TWO_POW_32;
}

/**
 * Image du repos, au cycle des règles (rules.idle) déphasé par l'animal : debout, un coup
 * d'oreille ou de queue, puis il broute, tête baissée et levée tous les `chew`, puis debout.
 */
export function idleFrame(walkMs: number, phase: number, idle: FaunaRules['idle']): number {
  const { period } = idle;
  const u = (((walkMs + phase * period) % period) + period) % period;
  if (u < idle.flick) return 0;
  if (u < idle.graze) return 1;
  if (u < idle.rise) return Math.floor((u - idle.graze) / idle.chew) % 2 === 0 ? 2 : 3;
  return 0;
}

/**
 * L'animation d'un animal à son allure : le galop pour la fuite, la marche au pas, le repos sinon.
 * Elle vient de l'état (FAUNA_GAIT), jamais de la vitesse apparente.
 */
export function animationOf(gait: number): number {
  if (gait === FAUNA_GAIT.run) return FAUNA_ANIMATION.run;
  if (gait === FAUNA_GAIT.walk) return FAUNA_ANIMATION.walk;
  return FAUNA_ANIMATION.idle;
}

/** Image d'une animation en mouvement : `cadence` images par pas du rendu, déphasées par l'animal. */
export function moveFrame(
  walkMs: number,
  stepMs: number,
  cadence: number,
  phase: number,
  frames: number,
): number {
  return Math.floor(walkMs / (stepMs / cadence) + phase * frames) % frames;
}

/** Palette d'une espèce : le contour, puis les quatre rangs de chaque région, de ses rampes. */
export function faunaPalette(species: FaunaSpecies, outline: string): ObjectPalette {
  const palette = new Array<ObjectColor | undefined>(PALETTE_ROLES);
  palette[1] = [...parseColor(outline), 255];
  for (const region of FAUNA_REGIONS) {
    const ramp = species.look[region];
    if (ramp === undefined) continue;
    ramp.forEach((color, rank) => {
      palette[legendRole(FAUNA_LEGEND, region, rank)] = [...parseColor(color), 255];
    });
  }
  return palette;
}

/** Ce que le rendu lit du gibier à l'instant affiché (la chronologie, app/faunaFrames.ts). */
export interface FaunaMotion {
  readonly frame: FaunaFrame | undefined;
  readonly version: number;
  readonly fallen: {
    readonly count: number;
    /** Instant de leur mort, en jours : celui de l'image qui ne les porte plus. */
    readonly at: number;
    readonly generation: number;
    readonly kinds: Uint8Array;
    readonly ids: Uint32Array;
    readonly positions: Int32Array;
    readonly facing: Int8Array;
  };
  position(index: number, t: number, out: Float64Array): void;
  gait(index: number, t: number): number;
  facing(index: number): number;
  /** L'étendue de l'étape du i-ième animal (app/faunaFrames.ts, FaunaSpan). */
  span(index: number, out: Float64Array): void;
  /** Rangs de l'image dont l'étape a changé depuis qu'elle vaut, dans l'ordre (app/faunaFrames.ts). */
  readonly moved: readonly number[];
}

/** Ce que coûte et ce que montre le gibier, pour le panneau de débogage. */
export interface FaunaStats {
  /** Animaux dont un pixel au moins tombe dans la vue, et ceux que le calque a regardés. */
  readonly drawn: number;
  readonly examined: number;
  /** Particules posées : copies de part et d'autre de la couture et marges des motifs comprises. */
  readonly particles: number;
  readonly updateMs: number;
}

/**
 * Côté des carrés de cases où se rangent les animaux : le calque ne regarde que ceux des carrés
 * que la vue touche (relecture 2b.6, problèmes 11 et 18 : il les regardait tous, à chaque image).
 */
export const FAUNA_BUCKET_CELLS = 16;

/** Le contenu du gibier dont le rendu se sert. */
export interface FaunaLook {
  readonly fauna: Catalog<FaunaSpecies>;
  readonly faunaRules: FaunaRules;
}

const point = new Float64Array(2);
const span = new Float64Array(4);

/** Le gibier d'une partie, source d'objets du calque commun. */
export class FaunaLayer implements ObjectSource {
  readonly atlas = FAUNA_ATLAS;
  private readonly list = new ObjectList();
  private readonly content: FaunaLook;
  private readonly motion: FaunaMotion;
  /** Largeur du monde, en cases : ses copies de part et d'autre de la couture. */
  private readonly columns: number;
  /** Formes de chaque espèce dans l'atlas : l'adulte, puis le mâle adulte (−1 sans lui). */
  private readonly forms: { form: number; male: number }[];
  /** Places des palettes de chaque espèce, de la génération `generation` de la texture. */
  private slots: number[] = [];
  private generation = -1;
  /** Ce qui dépasse des pieds des motifs de chaque niveau, en pixels de motif. */
  private readonly reaches: { wide: number; tall: number }[];
  /** La dernière génération de morts vue, et l'horloge de la marche à l'instant de leur mort. */
  private fallenGeneration = -1;
  private fallenStart = Number.NEGATIVE_INFINITY;
  /** L'instant affiché et l'horloge de la marche de la dernière mise à jour. */
  private lastT = Number.NaN;
  private lastWalk = 0;
  /** Phase de chaque animal de l'image `phasesOf`, tirée une fois par image. */
  private phases = new Float64Array(0);
  private phasesOf: FaunaFrame | undefined;
  /**
   * Les animaux de l'image rangés par carrés de FAUNA_BUCKET_CELLS cases, d'après le coin
   * nord-ouest de l'étendue de leur étape (FaunaSpan) : une liste par carré (`head`, puis `next` et
   * `prev` de chaque rang), refaite à chaque image, puis tenue à jour, rang par rang, à chaque
   * étape appliquée (`moved` de la chronologie, lu jusqu'à `consumed`). `reachX`, `reachY` : le
   * plus grand écart d'une étape, en cases, dont la recherche s'élargit vers l'ouest et le nord.
   */
  private indexedFrame: FaunaFrame | undefined;
  private consumed = 0;
  private bucketsX = 1;
  private bucketRows = 1;
  private head = new Int32Array(1).fill(-1);
  private next = new Int32Array(0);
  private prev = new Int32Array(0);
  private bucketOf = new Int32Array(0);
  /**
   * Le numéro de la dernière mise à jour qui a reclassé chaque animal (follow) : un animal dont
   * plusieurs étapes se sont appliquées depuis l'image d'avant ne se reclasse qu'une fois, à son
   * étape en cours.
   */
  private followedAt = new Uint32Array(0);
  private follows = 0;
  private reachX = 0;
  private reachY = 0;
  private stats_: FaunaStats = { drawn: 0, examined: 0, particles: 0, updateMs: 0 };

  constructor(content: FaunaLook, motion: FaunaMotion, columns: number) {
    this.content = content;
    this.motion = motion;
    this.columns = columns;
    this.forms = content.fauna.entries.map((species) => ({
      form: FAUNA_FORMS.indexOf(species.look.form),
      male: species.look.male === undefined ? -1 : FAUNA_FORMS.indexOf(species.look.male),
    }));
    this.reaches = Array.from({ length: faunaAtlas.levels }, (_, level) => {
      let wide = 1;
      let tall = 1;
      const { index, motifs, animations, levels } = faunaAtlas;
      for (let entry = level; entry < index.length; entry += levels) {
        const first = index[entry] ?? -1;
        if (first < 0) continue;
        const animation = Math.floor(entry / levels) % animations.length;
        for (let image = 0; image < (faunaAtlas.frames[animation] ?? 1); image++) {
          const at = (first + image) * 6;
          wide = Math.max(wide, motifs[at + 2] ?? 1);
          tall = Math.max(tall, motifs[at + 5] ?? 1);
        }
      }
      return { wide: wide + 1, tall: tall + 1 };
    });
  }

  /** Change quand la chronologie applique une image ou une étape (ObjectSource). */
  get version(): number {
    return this.motion.version;
  }

  get stats(): FaunaStats {
    return this.stats_;
  }

  /** Le premier motif de l'animation `animation` de l'animal de sorte `kind`, au niveau `level`. */
  private firstMotif(kind: number, animation: number, level: number): number {
    const forms = this.forms.at(kind & FAUNA_SPECIES);
    if (forms === undefined) return -1;
    const { index, animations, levels } = faunaAtlas;
    const entry = (form: number, age: number) =>
      form < 0
        ? -1
        : (index[((form * 2 + age) * animations.length + animation) * levels + level] ?? -1);
    // Un jeune, mâle ou non, se montre en jeune de la forme de l'espèce : le jeune du cerf n'est
    // pas rangé.
    if ((kind & FAUNA_YOUNG) !== 0) {
      const young = entry(forms.form, 1);
      if (young >= 0) return young;
    }
    if ((kind & FAUNA_MALE) !== 0 && forms.male >= 0) return entry(forms.male, 0);
    return entry(forms.form, 0);
  }

  /** La place de la palette de l'espèce `s`, rangée une fois par génération de la texture. */
  private slot(s: number, palettes: PaletteSlots): number {
    if (palettes.generation !== this.generation) {
      this.generation = palettes.generation;
      this.slots = [];
    }
    let slot = this.slots.at(s);
    if (slot === undefined) {
      const species = this.content.fauna.entries.at(s);
      const key = PALETTE_KEYS.fauna[0] + s;
      slot = palettes.slot(key, () =>
        species === undefined ? [] : faunaPalette(species, this.content.faunaRules.outline),
      );
      this.slots[s] = slot;
    }
    return slot;
  }

  update(view: ObjectView, palettes: PaletteSlots): ObjectList {
    const started = performance.now();
    const list = this.list;
    list.clear();
    this.drawn = 0;
    this.examined = 0;
    const frame = this.motion.frame;
    if (frame !== undefined) this.collect(frame, view, palettes);
    list.sort();
    this.stats_ = {
      drawn: this.drawn,
      examined: this.examined,
      particles: list.count,
      updateMs: performance.now() - started,
    };
    return list;
  }

  /** Animaux montrés et regardés à la mise à jour en cours (stats). */
  private drawn = 0;
  private examined = 0;

  /** Le carré du rang `index`, d'après l'étendue de son étape ; la portée de la recherche suit. */
  private bucketFor(index: number): number {
    const side = FAUNA_BUCKET_CELLS;
    this.motion.span(index, span);
    const x0 = span[0];
    const dx = span[1];
    const y0 = span[2];
    const dy = span[3];
    this.reachX = Math.max(this.reachX, Math.abs(dx) / FIXED);
    this.reachY = Math.max(this.reachY, Math.abs(dy) / FIXED);
    const west = x0 + Math.min(0, dx);
    const north = y0 + Math.min(0, dy);
    const column =
      ((Math.floor(west / FIXED / side) % this.bucketsX) + this.bucketsX) % this.bucketsX;
    const row = Math.max(0, Math.floor(north / FIXED / side));
    return row < this.bucketRows ? row * this.bucketsX + column : -1;
  }

  private link(index: number, bucket: number): void {
    const first = this.head[bucket] ?? -1;
    this.next[index] = first;
    this.prev[index] = -1;
    if (first >= 0) this.prev[first] = index;
    this.head[bucket] = index;
    this.bucketOf[index] = bucket;
  }

  private unlink(index: number): void {
    const bucket = this.bucketOf[index] ?? 0;
    const before = this.prev[index] ?? -1;
    const after = this.next[index] ?? -1;
    if (before >= 0) this.next[before] = after;
    else this.head[bucket] = after;
    if (after >= 0) this.prev[after] = before;
  }

  /** Range de nouveau chaque animal de l'image : à chaque image, ou quand un carré manque. */
  private rebuild(frame: FaunaFrame): void {
    const n = frame.ids.length;
    const side = FAUNA_BUCKET_CELLS;
    this.bucketsX = Math.max(1, Math.ceil(this.columns / side));
    this.reachX = 0;
    this.reachY = 0;
    // Les rangées de carrés que touchent les étapes de l'image, et une de plus.
    let rows = 1;
    for (let index = 0; index < n; index++) {
      this.motion.span(index, span);
      const y0 = span[2];
      const dy = span[3];
      rows = Math.max(rows, Math.floor((y0 + Math.min(0, dy)) / FIXED / side) + 1);
    }
    this.bucketRows = rows + 1;
    const buckets = this.bucketsX * this.bucketRows;
    if (this.head.length < buckets) this.head = new Int32Array(buckets);
    this.head.fill(-1);
    if (this.next.length < n) {
      const size = Math.max(n, 2 * this.next.length);
      this.next = new Int32Array(size);
      this.prev = new Int32Array(size);
      this.bucketOf = new Int32Array(size);
      this.followedAt = new Uint32Array(size);
      this.follows = 0;
    }
    // Du dernier rang au premier : chaque liste va par rangs croissants.
    for (let index = n - 1; index >= 0; index--) {
      this.link(index, Math.max(0, this.bucketFor(index)));
    }
    this.indexedFrame = frame;
    this.consumed = this.motion.moved.length;
  }

  /** Les rangs dont l'étape a changé depuis la dernière mise à jour changent de carré. */
  private follow(frame: FaunaFrame): void {
    const moved = this.motion.moved;
    if (this.consumed >= moved.length) return;
    this.follows = (this.follows + 1) >>> 0;
    if (this.follows === 0) {
      this.followedAt.fill(0);
      this.follows = 1;
    }
    for (let at = this.consumed; at < moved.length; at++) {
      const index = moved[at] ?? -1;
      if (index < 0 || index >= frame.ids.length) continue;
      // Une étape plus récente du même animal ne change rien : le carré suit l'étape en cours.
      if (this.followedAt[index] === this.follows) continue;
      this.followedAt[index] = this.follows;
      const bucket = this.bucketFor(index);
      if (bucket < 0) {
        // Plus bas que les carrés de l'image : on range tout de nouveau.
        this.rebuild(frame);
        return;
      }
      if (bucket === this.bucketOf[index]) continue;
      this.unlink(index);
      this.link(index, bucket);
    }
    this.consumed = moved.length;
  }

  private collect(frame: FaunaFrame, view: ObjectView, palettes: PaletteSlots): void {
    const { scale, level, k, t, walkMs, stepMs } = view;
    const rules = this.content.faunaRules;
    const unitPx = (TILE_PX * scale) / FIXED;
    const worldPx = this.columns * TILE_PX * scale;
    const reach = this.reaches[level] ?? { wide: 64, tall: 64 };
    // Les pieds qui peuvent montrer un pixel dans la vue, en pixels physiques depuis l'origine.
    const left = view.left * scale - reach.wide * k;
    const right = view.right * scale + reach.wide * k;
    const top = view.top * scale - k;
    const bottom = view.bottom * scale + reach.tall * k;
    const { motifs, frames } = faunaAtlas;
    if (frame !== this.phasesOf) {
      this.phasesOf = frame;
      this.phases = Float64Array.from(frame.ids, (id) => phaseOf(id));
    }
    if (frame !== this.indexedFrame || this.consumed > this.motion.moved.length) {
      this.rebuild(frame);
    } else {
      this.follow(frame);
    }
    // Le rectangle de la vue, en pixels physiques depuis l'origine, pour compter les animaux qui
    // y montrent un pixel.
    const viewLeft = view.left * scale;
    const viewRight = view.right * scale;
    const viewTop = view.top * scale;
    const viewBottom = view.bottom * scale;
    const place = (
      kind: number,
      phase: number,
      animation: number,
      image: number,
      x: number,
      y: number,
      sense: number,
    ) => {
      const footY = Math.round(y * unitPx);
      if (footY < top || footY > bottom) return;
      // Chaque copie du monde que la vue touche, de part et d'autre de la couture.
      const base = x * unitPx;
      const first = Math.ceil((left - base) / worldPx);
      const last = Math.floor((right - base) / worldPx);
      if (last < first) return;
      const start = this.firstMotif(kind, animation, level);
      if (start < 0) return;
      const motif = start + image;
      const at = motif * 6;
      const width = motifs[at + 2] ?? 1;
      const height = motifs[at + 3] ?? 1;
      const feetX = motifs[at + 4] ?? 0;
      // Sans étape connue, chacun garde le sens que lui donne sa phase.
      const east = sense > 0 || (sense === 0 && phase >= 0.5);
      const slot = this.slot(kind & FAUNA_SPECIES, palettes);
      let shown = false;
      for (let copy = first; copy <= last; copy++) {
        const footX = Math.round(base + copy * worldPx);
        const rect = footX - (east ? width - feetX : feetX) * k;
        shown ||=
          rect < viewRight &&
          rect + width * k > viewLeft &&
          footY - height * k < viewBottom &&
          footY > viewTop;
        this.list.push(
          rect,
          footY - height * k,
          footY,
          width * k,
          height * k,
          motif,
          slot,
          k,
          east ? OBJECT_FLAG.flip : 0,
        );
      }
      if (shown) this.drawn++;
    };
    const visit = (index: number) => {
      this.examined++;
      this.motion.position(index, t, point);
      const animation = animationOf(this.motion.gait(index, t));
      const phase = this.phases[index] ?? 0;
      const count = frames[animation] ?? 1;
      const image =
        animation === FAUNA_ANIMATION.idle
          ? idleFrame(walkMs, phase, rules.idle) % count
          : moveFrame(
              walkMs,
              stepMs,
              animation === FAUNA_ANIMATION.run ? rules.cadence.run : rules.cadence.walk,
              phase,
              count,
            );
      const kind = frame.kinds[index] ?? 0;
      place(kind, phase, animation, image, point[0], point[1], this.motion.facing(index));
    };
    // Les seuls carrés que la vue touche, élargie vers l'ouest et le nord du plus grand écart
    // d'une étape : un animal se tient entre le coin nord-ouest de son étape et cet écart.
    const cellPx = TILE_PX * scale;
    const side = FAUNA_BUCKET_CELLS;
    const fromColumn = Math.floor((left / cellPx - this.reachX) / side);
    const toColumn = Math.floor(right / cellPx / side);
    const fromRow = Math.max(0, Math.floor((top / cellPx - this.reachY) / side));
    const toRow = Math.min(this.bucketRows - 1, Math.floor(bottom / cellPx / side));
    const columns = Math.min(this.bucketsX, toColumn - fromColumn + 1);
    for (let row = fromRow; row <= toRow; row++) {
      for (let step = 0; step < columns; step++) {
        const column = (((fromColumn + step) % this.bucketsX) + this.bucketsX) % this.bucketsX;
        const bucket = row * this.bucketsX + column;
        for (let index = this.head[bucket] ?? -1; index >= 0; index = this.next[index] ?? -1) {
          visit(index);
        }
      }
    }
    // Les morts de la dernière image tombent, là où ils étaient, puis disparaissent.
    const fallen = this.motion.fallen;
    if (fallen.generation !== this.fallenGeneration) {
      this.fallenGeneration = fallen.generation;
      this.fallenStart = this.walkAt(fallen.at, t, walkMs);
    }
    this.lastT = t;
    this.lastWalk = walkMs;
    const since = walkMs - this.fallenStart;
    if (fallen.count > 0 && since < rules.fall.lie) {
      const image = Math.min(
        since < rules.fall.stumble ? 0 : 1,
        (frames[FAUNA_ANIMATION.fall] ?? 1) - 1,
      );
      for (let index = 0; index < fallen.count; index++) {
        place(
          fallen.kinds[index] ?? 0,
          phaseOf(fallen.ids[index] ?? 0),
          FAUNA_ANIMATION.fall,
          image,
          fallen.positions[2 * index] ?? 0,
          fallen.positions[2 * index + 1] ?? 0,
          fallen.facing[index] ?? 0,
        );
      }
    }
  }

  /**
   * L'horloge de la marche à l'instant `at` (jours), vu pour la première fois à l'instant `t` :
   * entre la mise à jour précédente et celle-ci, à proportion de l'instant affiché, qui avance
   * avec elle. Hors de la vue rapprochée, le calque ne se met pas à jour : des morts d'il y a
   * longtemps ne tombent pas quand on y revient. Avant toute mise à jour, on ne sait pas.
   */
  private walkAt(at: number, t: number, walkMs: number): number {
    const { lastT, lastWalk } = this;
    if (Number.isNaN(lastT)) return Number.NEGATIVE_INFINITY;
    if (t <= lastT || at <= lastT) return walkMs;
    return lastWalk + ((walkMs - lastWalk) * (Math.min(at, t) - lastT)) / (t - lastT);
  }
}
