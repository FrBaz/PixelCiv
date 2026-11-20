/**
 * Décor en objets sur la carte (tâche 2b.6 ; MON-10, REN-03, REN-08 à REN-10 ; ADR 0017).
 *
 * La pose est celle de src/gen/decor.ts, fonction pure de la graine et des couches ; ce module la
 * garde par bloc de 64 × 64 cases (au plus MAX_CHUNKS, le moins récemment vu partant le premier),
 * puis collecte les objets que la vue peut montrer : leur motif au niveau et à la densité k de la
 * vue, leur palette selon l'espèce, l'état de son feuillage, la neige et le fruit, rangée une fois
 * par clé dans la texture des palettes des humains. Les positions se comptent depuis l'origine de
 * la carte à l'écran : quand la vue défile sans quitter les cases collectées (par carrés de
 * COLLECT_CELLS), rien ne se recollecte ; quand le jour change, seuls les états se refont.
 *
 * Saisons : la part de neige d'une case vient des codes de la texture des saisons, par la formule
 * du shader de la carte (src/render/seasons.ts, snowShare) ; le feuillage, du climat de la case
 * (src/gen/decor.ts, decorSeason). Rien n'est recuit : seules la palette et, pour un caduc nu, le
 * motif changent.
 */
import decorAtlas from 'virtual:decor-atlas';
import type { Decor, GameData, LandUse, ShadowMethod } from '../core/data';
import { PALETTE_ROLES } from '../core/data/humans';
import { latitude, rainSeasonality, southern } from '../core/seasons';
import { CHUNK_SIZE, type WorldLayers, type WorldSize } from '../core/world';
import {
  cellObjects,
  compileDecor,
  DECOR_STATE,
  decorKey,
  decorSeasonCode,
  entryOf,
  fruitingMask,
  monthMask,
  seasonMoment,
  variantOf,
  type DecorLook,
  type DecorState,
  type DecorTable,
  type DecorWorld,
  type Placed,
} from '../gen/decor';
import { DECOR_LEGEND, legendRole } from '../gen/legend';
import { parseColor } from './bake';
import { TILE_PX } from './camera';
import { LEVEL_ROWS } from './humans';
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
import { biomeCodes, cellSeasonCodes, snowShare, snowThreshold } from './seasons';

/** Rôles de l'atlas du décor, un octet par pixel, décodés une fois. */
function decodeRoles(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/** L'atlas du décor, rangé au build (tools/decor-atlas.ts). */
export const DECOR_ATLAS: ObjectAtlas = {
  width: decorAtlas.width,
  height: decorAtlas.height,
  roles: decodeRoles(decorAtlas.roles),
  motifs: decorAtlas.motifs,
  shadowRoles: [legendRole(DECOR_LEGEND, 'shadow', 0), legendRole(DECOR_LEGEND, 'shadow', 1)],
};
export const DECOR_FORMS = decorAtlas.forms;
export const DECOR_LEVELS = decorAtlas.levels;

/**
 * Par niveau de motifs, la hauteur moyenne des motifs du décor au-dessus de leurs pieds, rapportée
 * à celle de la planche (niveau 0) : de quoi choisir le niveau du décor (DecorSource.levelFor).
 */
export function decorLevelHeights(): Float64Array {
  const sums = new Float64Array(DECOR_LEVELS);
  for (let source = 0; source < decorAtlas.names.length; source++) {
    for (let level = 0; level < DECOR_LEVELS; level++) {
      sums[level] =
        (sums.at(level) ?? 0) + (DECOR_ATLAS.motifs[(source * DECOR_LEVELS + level) * 6 + 5] ?? 0);
    }
  }
  const base = sums.at(0) ?? 1;
  return sums.map((sum) => sum / base);
}

/** Blocs de pose gardés au plus : de quoi couvrir un grand écran au zoom 3, ses abords compris. */
export const MAX_CHUNKS = 64;
/**
 * Les cases se collectent par carrés de COLLECT_CELLS de côté, au-delà de ce que la vue montre :
 * la vue défile d'autant sans rien recollecter.
 */
export const COLLECT_CELLS = 32;

/** Rôles de l'ombre portée, en damier (tools/role-grids.ts, withShadow). */
export const SHADOW_ROLES = [
  legendRole(DECOR_LEGEND, 'shadow', 0),
  legendRole(DECOR_LEGEND, 'shadow', 1),
] as const;

/** Les objets posés d'un bloc, compactés : gardés tant que ses cases ne changent pas. */
interface ChunkObjects {
  readonly count: number;
  /** Case dans le bloc : rangée × 64 + colonne. */
  readonly local: Uint16Array;
  readonly look: Uint16Array;
  readonly variant: Uint8Array;
  /** Pieds dans la case, en 65 536es de son côté. */
  readonly fx: Uint16Array;
  readonly fy: Uint16Array;
}

const UNIT16 = 65535;

/** Les tons d'une rampe de quatre couleurs, opaques. */
function rampColors(ramp: readonly string[]): ObjectColor[] {
  return ramp.map((hex) => [...parseColor(hex), 255] as const);
}

/** Ce qui choisit la palette d'un objet. */
export interface DecorLookState {
  readonly look: number;
  readonly state: DecorState;
  readonly snowy: boolean;
  readonly fruit: boolean;
  /** Biome dont la palette de couverture blanchit l'objet enneigé. */
  readonly biome: number;
}

/**
 * La palette d'un objet : chaque rôle de ses motifs reçoit un ton des données, et aucun ton n'est
 * calculé (REN-09). Le contour est celui des données ; le feuillage, la rampe de l'état (l'hiver
 * d'une caduque sans grilles nues prend ses tons d'hiver, ou d'automne) ; le fruit, ses tons
 * pendant ses mois, le feuillage sinon ; la neige, sous la neige, la palette de couverture du
 * biome et le ton profond des données, et hors neige ce qu'elle recouvre ; le chaperon, le contour
 * hors neige et la neige sous la neige ; l'ombre, selon la méthode.
 */
export function decorPalette(
  data: Pick<GameData, 'flora' | 'resources' | 'biomes'> & { readonly decor: Decor },
  table: DecorTable,
  choice: DecorLookState,
  method: ShadowMethod,
): ObjectPalette {
  const { decor } = data;
  const palette: (ObjectColor | undefined)[] = new Array<ObjectColor | undefined>(PALETTE_ROLES);
  const outline: ObjectColor = [...parseColor(decor.outline), 255];
  palette[1] = outline;
  const set = (region: string, colors: readonly ObjectColor[]) => {
    colors.forEach((color, rank) => {
      palette[legendRole(DECOR_LEGEND, region, rank)] = color;
    });
  };
  const look: DecorLook | undefined = table.looks.at(choice.look);
  const flora = look === undefined ? undefined : entryOf(data.flora.entries, look.flora);
  const stone = rampColors(decor.stone);
  const foliage = flora?.look.foliage;
  const current =
    foliage === undefined
      ? stone
      : rampColors(
          choice.state === DECOR_STATE.autumn
            ? (foliage.autumn ?? foliage.summer)
            : choice.state === DECOR_STATE.dry
              ? (foliage.dry ?? foliage.summer)
              : choice.state === DECOR_STATE.bare
                ? (foliage.bare ?? foliage.autumn ?? foliage.summer)
                : foliage.summer,
        );
  const wood = flora === undefined ? stone : rampColors(flora.look.wood);
  const mineral = look === undefined ? undefined : entryOf(data.resources.entries, look.mineral);
  const deposit =
    mineral !== undefined && Object.hasOwn(decor.deposits, mineral.id)
      ? decor.deposits[mineral.id]
      : undefined;
  set('foliage', current);
  set('wood', wood);
  set(
    'fruit',
    choice.fruit && flora?.look.fruit !== undefined ? rampColors(flora.look.fruit.tones) : current,
  );
  set('stone', stone);
  set('ore', deposit?.ore === undefined ? stone : rampColors(deposit.ore));
  const cover = data.biomes.entries.at(choice.biome)?.seasons.palette;
  const snow =
    choice.snowy && cover !== undefined
      ? rampColors([cover.light, cover.base, cover.shadow, decor.snow.deep])
      : undefined;
  const bareGrid = choice.state === DECOR_STATE.bare && look?.bare !== undefined;
  const under = flora === undefined ? stone : bareGrid ? wood : current;
  set('snow', snow ?? under);
  set('cap', snow ?? [outline, outline, outline, outline]);
  const [even, odd] = SHADOW_ROLES;
  if (method === 'multiply') {
    const shade: ObjectColor = [0, 0, 0, Math.round(decor.shadow.alpha * 255)];
    palette[even] = shade;
    palette[odd] = shade;
  } else if (method === 'dither') {
    palette[even] = outline;
  } else if (method === 'ground') {
    // Le shader y lit le ton d'ombre du sol (OBJECT_FLAG.ground) ; la palette n'en dit rien.
    palette[even] = outline;
    palette[odd] = outline;
  }
  return palette;
}

/** Ce que coûte le décor, pour le panneau de débogage. */
export interface DecorStats {
  /** Objets collectés, durée de la dernière mise à jour (ms), blocs posés et leur durée (ms). */
  readonly collected: number;
  readonly updateMs: number;
  readonly chunksBuilt: number;
  readonly buildMs: number;
  readonly cachedChunks: number;
}

/** Le décor d'un monde, source d'objets du calque commun (src/render/objects.ts). */
export class DecorSource implements ObjectSource {
  readonly atlas = DECOR_ATLAS;
  version = 0;
  private method: ShadowMethod;
  private readonly data: Pick<GameData, 'flora' | 'resources' | 'biomes'> & {
    readonly decor: Decor;
  };
  private readonly world: DecorWorld;
  private readonly landUse: LandUse;
  private readonly chunks = new Map<number, ChunkObjects>();
  private readonly list = new ObjectList();
  /** Pour chaque objet collecté, dans l'ordre d'ajout : de quoi refaire son état. */
  private cells = new Int32Array(0);
  private columns = new Int32Array(0);
  private feetX = new Int32Array(0);
  private looks = new Uint16Array(0);
  private variants = new Uint8Array(0);
  private codes = new Uint8Array(0);
  private climate = new Float64Array(0);
  /** L'objet est-il au sud ? Lu de sa case une fois par collecte. */
  private souths = new Uint8Array(0);
  /**
   * L'intervalle de g (facteur de saison signé par l'hémisphère) où la composition de l'objet ne
   * change pas, cooling et mois du fruit mis à part : ses seuils les plus proches, resserrés de
   * INTERVAL_MARGIN. Hors de lui, l'objet se réévalue ; dedans, rien ne change.
   */
  private lows = new Float64Array(0);
  private highs = new Float64Array(0);
  /** Ce qu'ont vu les derniers états : refroidissement au nord et au sud, mois du nord. */
  private lastCooling = -1;
  private lastMonth = -1;
  private readonly seasonCodes: ReturnType<typeof biomeCodes>;
  private choices = new Int32Array(0);
  /** Clé de la dernière collecte, et jour de ses états. */
  private collectedWith: readonly number[] = [];
  private day = Number.NaN;
  /** Identifiants des palettes, denses, par composition (palette clé). */
  private readonly paletteIds = new Map<number, number>();
  private readonly placed: Placed[] = [0, 1, 2].map(() => ({ look: 0, variant: 0, fx: 0, fy: 0 }));
  /** Par apparence : les mois de son fruit en masque (monthMask), 0 sans fruit. */
  private readonly fruitMasks: Int32Array;
  /**
   * Par niveau de motifs : la hauteur moyenne des motifs du décor rapportée à celle de la planche
   * (levelFor), et le niveau de la dernière mise à jour.
   */
  private readonly levelHeights: Float64Array;
  private level = 0;
  private stats_: DecorStats = {
    collected: 0,
    updateMs: 0,
    chunksBuilt: 0,
    buildMs: 0,
    cachedChunks: 0,
  };
  private chunksBuilt = 0;
  private buildMs = 0;

  constructor(
    data: Pick<GameData, 'flora' | 'resources' | 'biomes'> & { readonly decor: Decor },
    layers: WorldLayers,
    size: WorldSize,
    seed: string,
  ) {
    this.data = data;
    this.method = data.decor.shadow.method;
    this.world = {
      size,
      layers,
      biomes: data.biomes.entries,
      table: compileDecor(data),
      key: decorKey(seed),
    };
    this.landUse = Object.hasOwn(data.decor.landUse, 'none')
      ? data.decor.landUse.none
      : { trees: 1, shrubs: 1, rocks: 1 };
    this.seasonCodes = biomeCodes(data.biomes.entries);
    this.fruitMasks = Int32Array.from(this.world.table.looks, (look) => {
      const months = entryOf(data.flora.entries, look.flora)?.look.fruit?.months;
      return months === undefined ? 0 : monthMask(months);
    });
    this.levelHeights = decorLevelHeights();
  }

  /**
   * Le niveau de motifs du décor dans la vue (relecture 2b.6, problème 7) : à la densité k des
   * individus, celui dont les motifs approchent le plus la taille que leur donne la planche à la
   * hauteur que vise l'adulte de référence, à égalité le plus fin. Les arbres gardent ainsi leur
   * taille par rapport à la case d'un zoom à l'autre, au lieu de suivre les sauts du niveau des
   * individus (de 0,85 à 1,42 case entre les zooms 20 et 24 sur PC) ; la densité, elle, reste
   * celle des individus (REN-08).
   */
  levelFor(view: Pick<ObjectView, 'k' | 'target'>): number {
    const ideal = view.target / LEVEL_ROWS[0];
    let best = 0;
    let error = Number.POSITIVE_INFINITY;
    this.levelHeights.forEach((height, level) => {
      const gap = Math.abs(height * view.k - ideal);
      if (gap < error - 1e-9) {
        best = level;
        error = gap;
      }
    });
    return best;
  }

  /** Méthode de l'ombre portée ; une autre refait la collecte. */
  get shadow(): ShadowMethod {
    return this.method;
  }

  set shadow(method: ShadowMethod) {
    if (method === this.method) return;
    this.method = method;
    this.version++;
  }

  /** Ce que coûte le décor, à la dernière mise à jour. */
  get stats(): DecorStats {
    return this.stats_;
  }

  /** Le monde que pose le décor (essais). */
  get decorWorld(): DecorWorld {
    return this.world;
  }

  /**
   * Des cases ont changé (le pinceau, puis l'occupation du sol de la phase 3) : les blocs
   * nommés, ou tous, se reposent, et la prochaine image recollecte.
   */
  invalidate(chunks?: readonly { readonly column: number; readonly row: number }[]): void {
    this.version++;
    if (chunks === undefined) {
      this.chunks.clear();
      return;
    }
    const columns = this.world.size.width / CHUNK_SIZE;
    for (const { column, row } of chunks) this.chunks.delete(row * columns + column);
  }

  /** Blocs gardés (essais). */
  get cachedChunks(): number {
    return this.chunks.size;
  }

  /** Les objets posés du bloc (cx, cy), posés à sa première demande. */
  private chunk(cx: number, cy: number): ChunkObjects {
    const columns = this.world.size.width / CHUNK_SIZE;
    const id = cy * columns + cx;
    const known = this.chunks.get(id);
    if (known !== undefined) {
      // Le plus récent en dernier : le moins récemment vu part le premier.
      this.chunks.delete(id);
      this.chunks.set(id, known);
      return known;
    }
    const started = performance.now();
    const capacity = CHUNK_SIZE * CHUNK_SIZE * 3;
    const local = new Uint16Array(capacity);
    const look = new Uint16Array(capacity);
    const variant = new Uint8Array(capacity);
    const fx = new Uint16Array(capacity);
    const fy = new Uint16Array(capacity);
    let count = 0;
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const placed = cellObjects(
          this.world,
          cx * CHUNK_SIZE + x,
          cy * CHUNK_SIZE + y,
          this.landUse,
          this.placed,
        );
        for (let index = 0; index < placed; index++) {
          const object = this.placed.at(index);
          if (object === undefined) continue;
          local[count] = y * CHUNK_SIZE + x;
          look[count] = object.look;
          variant[count] = object.variant;
          fx[count] = Math.round(object.fx * UNIT16);
          fy[count] = Math.round(object.fy * UNIT16);
          count++;
        }
      }
    }
    const built: ChunkObjects = {
      count,
      local: local.slice(0, count),
      look: look.slice(0, count),
      variant: variant.slice(0, count),
      fx: fx.slice(0, count),
      fy: fy.slice(0, count),
    };
    this.chunks.set(id, built);
    while (this.chunks.size > MAX_CHUNKS) {
      const oldest = this.chunks.keys().next();
      if (oldest.done === true) break;
      this.chunks.delete(oldest.value);
    }
    this.chunksBuilt++;
    this.buildMs += performance.now() - started;
    return built;
  }

  /** Les objets de la vue, triés par leurs pieds (ObjectSource). */
  update(view: ObjectView, palettes: PaletteSlots): ObjectList {
    const started = performance.now();
    const { height } = this.world.size;
    const { scale, k } = view;
    const level = this.levelFor(view);
    this.level = level;
    const cellPx = TILE_PX * scale;
    const reach = this.reach(level);
    // Ce qui dépasse d'un objet : vers le haut sa hauteur, de chaque côté sa largeur (ombre
    // comprise), vers le bas l'ombre sous ses pieds.
    const c0 = Math.floor((view.left - (reach.wide * k) / scale) / TILE_PX);
    const c1 = Math.floor((view.right + (reach.wide * k) / scale) / TILE_PX);
    const r0 = Math.floor((view.top - (reach.below * k) / scale) / TILE_PX);
    const r1 = Math.floor((view.bottom + (reach.tall * k) / scale) / TILE_PX);
    const q = COLLECT_CELLS;
    const key = [
      this.version,
      palettes.generation,
      scale,
      level,
      k,
      Math.floor(c0 / q),
      Math.floor(c1 / q),
      Math.floor(r0 / q),
      Math.floor(r1 / q),
    ];
    const day = Math.floor(view.month * 30);
    if (key.every((value, index) => value === this.collectedWith[index])) {
      if (day !== this.day) this.refreshStates(view, palettes);
    } else {
      this.collectedWith = key;
      this.collect(
        view,
        palettes,
        Math.floor(c0 / q) * q,
        Math.floor(c1 / q) * q + q - 1,
        Math.max(0, Math.floor(r0 / q) * q),
        Math.min(height - 1, Math.floor(r1 / q) * q + q - 1),
        cellPx,
      );
    }
    this.day = day;
    this.stats_ = {
      collected: this.list.count,
      updateMs: performance.now() - started,
      chunksBuilt: this.chunksBuilt,
      buildMs: this.buildMs,
      cachedChunks: this.chunks.size,
    };
    return this.list;
  }

  /** Ce qui dépasse des pieds des motifs d'un niveau, en pixels de motif. */
  private reach(level: number): { tall: number; wide: number; below: number } {
    let tall = 1;
    let wide = 1;
    let below = 1;
    const { motifs } = DECOR_ATLAS;
    for (let source = 0; source < decorAtlas.names.length; source++) {
      const at = (source * DECOR_LEVELS + level) * 6;
      const w = motifs[at + 2] ?? 1;
      const h = motifs[at + 3] ?? 1;
      const ay = motifs[at + 5] ?? 1;
      wide = Math.max(wide, w);
      tall = Math.max(tall, ay);
      below = Math.max(below, h - ay);
    }
    return { tall: tall + 1, wide: wide + 1, below: below + 1 };
  }

  /** Collecte les objets des colonnes [c0, c1] (sans repli) et des rangées [r0, r1]. */
  private collect(
    view: ObjectView,
    palettes: PaletteSlots,
    c0: number,
    c1: number,
    r0: number,
    r1: number,
    cellPx: number,
  ): void {
    const list = this.list;
    list.clear();
    const { width } = this.world.size;
    const chunkColumns = width / CHUNK_SIZE;
    let count = 0;
    for (let cy = Math.floor(r0 / CHUNK_SIZE); cy <= Math.floor(r1 / CHUNK_SIZE); cy++) {
      for (let kx = Math.floor(c0 / CHUNK_SIZE); kx <= Math.floor(c1 / CHUNK_SIZE); kx++) {
        const cx = ((kx % chunkColumns) + chunkColumns) % chunkColumns;
        // Colonne du bloc dans la copie du monde que montre la vue.
        const shift = kx * CHUNK_SIZE;
        const chunk = this.chunk(cx, cy);
        for (let index = 0; index < chunk.count; index++) {
          const local = chunk.local[index] ?? 0;
          const row = cy * CHUNK_SIZE + (local >> 6);
          if (row < r0 || row > r1) continue;
          const column = shift + (local & 63);
          if (column < c0 || column > c1) continue;
          this.reserve(count + 1);
          const cell = row * width + cx * CHUNK_SIZE + (local & 63);
          this.cells[count] = cell;
          this.columns[count] = column;
          this.looks[count] = chunk.look[index] ?? 0;
          this.variants[count] = chunk.variant[index] ?? 0;
          // Les pieds, depuis l'origine de la carte à l'écran.
          const footX = Math.round((column + (chunk.fx[index] ?? 0) / UNIT16) * cellPx);
          const feet = Math.round((row + (chunk.fy[index] ?? 0) / UNIT16) * cellPx);
          this.feetX[count] = footX;
          this.prepare(count, cell, row);
          list.push(footX, 0, feet, 0, 0, 0, 0, view.k);
          count++;
        }
      }
    }
    this.day = Number.NaN;
    this.choices.fill(-1, 0, count);
    // Tout objet collecté se réévalue : un intervalle vide.
    this.lows.fill(Number.POSITIVE_INFINITY, 0, count);
    this.highs.fill(Number.NEGATIVE_INFINITY, 0, count);
    this.refreshStates(view, palettes);
    list.sort();
  }

  /** Place pour `count` objets collectés. */
  private reserve(count: number): void {
    if (count <= this.cells.length) return;
    const size = Math.max(count, this.cells.length * 2, 1024);
    const grow = <T extends Int32Array | Uint16Array | Uint8Array | Float64Array>(
      array: T,
      per = 1,
    ): T => {
      const next = new (array.constructor as new (length: number) => T)(size * per);
      next.set(array);
      return next;
    };
    this.cells = grow(this.cells);
    this.columns = grow(this.columns);
    this.feetX = grow(this.feetX);
    this.looks = grow(this.looks);
    this.variants = grow(this.variants);
    this.codes = grow(this.codes, 3);
    this.climate = grow(this.climate, 3);
    this.souths = grow(this.souths);
    this.lows = grow(this.lows);
    this.highs = grow(this.highs);
    this.choices = grow(this.choices);
  }

  /** Ce que l'état d'un objet lit de sa case, une fois par collecte. */
  private prepare(at: number, cell: number, row: number): void {
    const { layers, size } = this.world;
    const south = southern(row, size.height);
    const codes = cellSeasonCodes(layers, this.seasonCodes, cell, south);
    this.souths[at] = south ? 1 : 0;
    this.codes[at * 3] = codes.temperature;
    this.codes[at * 3 + 1] = codes.amplitude;
    this.codes[at * 3 + 2] = codes.flags;
    this.climate[at * 3] = layers.temperature[cell] / 10;
    this.climate[at * 3 + 1] = layers.amplitude[cell] / 10;
    this.climate[at * 3 + 2] = rainSeasonality(latitude(row, size.height));
  }

  /**
   * Les états de saison des objets collectés au mois de la vue, et ce qui en dépend. Un objet ne se
   * réévalue que lorsque le facteur de saison sort de l'intervalle où sa composition ne change
   * pas, quand le refroidissement change, ou quand son fruit paraît ou disparaît au nouveau
   * mois ; seuls les objets dont la composition change reprennent motif et palette (relecture
   * 2b.6, problème 17 : chaque jour, tous les objets collectés se réévaluaient).
   */
  private refreshStates(view: ObjectView, palettes: PaletteSlots): void {
    const list = this.list;
    const moment = seasonMoment(view.month);
    const { table } = this.world;
    const { k } = view;
    const level = this.level;
    const rules = this.data.decor;
    const { motifs } = DECOR_ATLAS;
    const flags = this.method === 'ground' ? OBJECT_FLAG.ground : 0;
    const { factor } = moment;
    const cooling = (moment.coolingNorth ? 1 : 0) + (moment.coolingSouth ? 2 : 0);
    const month = Math.floor(moment.month) % 12;
    const previousMonth = this.lastMonth;
    const coolingChanged = cooling !== this.lastCooling;
    const monthChanged = month !== previousMonth;
    this.lastCooling = cooling;
    this.lastMonth = month;
    // Les seuils de g les plus proches de part et d'autre, que bound resserre (ci-dessous) : une
    // seule fonction pour toute la passe, sans allocation par objet.
    let g = 0;
    let low = Number.NEGATIVE_INFINITY;
    let high = Number.POSITIVE_INFINITY;
    const bound = (threshold: number) => {
      if (Number.isNaN(threshold)) return;
      if (threshold < g - INTERVAL_MARGIN) low = Math.max(low, threshold);
      else if (threshold > g + INTERVAL_MARGIN) high = Math.min(high, threshold);
      else {
        low = Number.POSITIVE_INFINITY;
        high = Number.NEGATIVE_INFINITY;
      }
    };
    for (let at = 0; at < list.count; at++) {
      const lookIndex = this.looks[at] ?? 0;
      const mask = this.fruitMasks[lookIndex] ?? 0;
      const south = this.souths[at] === 1;
      g = south ? -factor : factor;
      // Le fruit ne change qu'entre un mois où il se montre et un mois où il ne se montre pas : au
      // nouveau mois, seuls les objets dont le fruit paraît ou disparaît se réévaluent.
      const shift = south ? 6 : 0;
      const fruitChanged =
        monthChanged &&
        mask !== 0 &&
        (previousMonth < 0 ||
          ((mask >> ((month + shift) % 12)) & 1) !==
            ((mask >> ((previousMonth + shift) % 12)) & 1));
      if (
        !coolingChanged &&
        !fruitChanged &&
        g > (this.lows[at] ?? 0) &&
        g < (this.highs[at] ?? 0)
      ) {
        continue;
      }
      const look = table.looks.at(lookIndex);
      if (look === undefined) continue;
      const cell = this.cells[at] ?? 0;
      const temperatureCode = this.codes[at * 3] ?? 0;
      const amplitudeCode = this.codes[at * 3 + 1] ?? 0;
      const flagCode = this.codes[at * 3 + 2] ?? 0;
      const snow = snowShare(temperatureCode, amplitudeCode, flagCode, factor);
      // Le climat du feuillage (foliageClimate), sans objet.
      const annual = this.climate[at * 3] ?? 0;
      const amplitude = this.climate[at * 3 + 1] ?? 0;
      const rain = this.climate[at * 3 + 2] ?? 0;
      const code = decorSeasonCode(
        snow,
        look.phenology,
        annual + amplitude * g,
        annual - amplitude,
        annual + amplitude,
        south ? moment.coolingSouth : moment.coolingNorth,
        1 + rain * g,
        rules,
      );
      const state = (code & 3) as DecorState;
      const snowy = code >= 4;
      const fruit = mask !== 0 && fruitingMask(mask, moment.month, south);
      // Les seuils de g les plus proches, de part et d'autre : la neige de la case, puis, selon
      // les saisons de l'espèce, le feuillage nu, l'automne, la saison sèche.
      // Un seuil à moins de INTERVAL_MARGIN de g laisse l'état incertain : l'intervalle est vide,
      // et l'objet se réévalue jusqu'à s'en écarter.
      low = Number.NEGATIVE_INFINITY;
      high = Number.POSITIVE_INFINITY;
      bound(snowThreshold(temperatureCode, amplitudeCode, flagCode, rules.snow.share));
      if (amplitude > 0 && look.phenology === 'deciduous') {
        const { bareBelow, autumnBelow, autumnDrop } = rules.foliage;
        bound((bareBelow - annual) / amplitude);
        bound((autumnBelow - annual) / amplitude);
        bound(1 - autumnDrop / amplitude);
      }
      if (rain !== 0 && look.phenology === 'dry') bound((rules.foliage.dryShare - 1) / rain);
      this.lows[at] = low + INTERVAL_MARGIN;
      this.highs[at] = high - INTERVAL_MARGIN;
      const biome = snowy ? (this.world.layers.biome[cell] ?? 0) : 0;
      // Composition de la palette : apparence, état, neige, fruit, biome de la neige, méthode.
      const choice =
        ((((lookIndex * 4 + state) * 2 + (snowy ? 1 : 0)) * 2 + (fruit ? 1 : 0)) * 256 + biome) *
          4 +
        SHADOW_CODE[this.method];
      if (choice === this.choices[at]) continue;
      this.choices[at] = choice;
      const forms = state === DECOR_STATE.bare && look.bare !== undefined ? look.bare : look.form;
      const sources = Object.hasOwn(DECOR_FORMS, forms) ? DECOR_FORMS[forms] : [];
      const source = sources.at(variantOf(this.variants[at] ?? 0, sources.length)) ?? 0;
      const motif = source * DECOR_LEVELS + level;
      const m = motif * 6;
      const w = motifs[m + 2] ?? 1;
      const h = motifs[m + 3] ?? 1;
      const ax = motifs[m + 4] ?? 0;
      const ay = motifs[m + 5] ?? 0;
      const feet = list.feet[at] ?? 0;
      list.left[at] = (this.feetX[at] ?? 0) - ax * k;
      list.top[at] = feet - ay * k;
      list.width[at] = w * k;
      list.height[at] = h * k;
      list.motif[at] = motif;
      list.unit[at] = k;
      list.flags[at] = flags;
      list.slot[at] = palettes.slot(this.paletteKey(choice), () =>
        decorPalette(
          this.data,
          table,
          { look: lookIndex, state, snowy, fruit, biome },
          this.method,
        ),
      );
    }
  }

  /** La clé de la palette d'une composition, dense, dans les clés du décor. */
  private paletteKey(choice: number): number {
    let id = this.paletteIds.get(choice);
    if (id === undefined) {
      id = this.paletteIds.size;
      this.paletteIds.set(choice, id);
    }
    const key = PALETTE_KEYS.decor[0] + id;
    if (key >= PALETTE_KEYS.decor[1]) throw new RangeError('palettes du décor : clés épuisées');
    return key;
  }
}

/**
 * Marge des intervalles de g où la composition d'un objet ne change pas (refreshStates) : près
 * d'un seuil, l'objet se réévalue, si bien que l'arrondi des seuils ne peut rien changer. Un jour
 * déplace g de 2π / 360 au plus, quelque 0,017.
 */
const INTERVAL_MARGIN = 1e-6;

/** Code de chaque méthode d'ombre, dans la composition des palettes. */
const SHADOW_CODE: Readonly<Record<ShadowMethod, number>> = {
  ground: 0,
  multiply: 1,
  dither: 2,
  none: 3,
};
