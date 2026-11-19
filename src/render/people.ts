/**
 * Individus et groupes sur la carte (tâches 2.9, 2b.2, 2b.3 et 2b.5 ; REN-03, REN-04, REN-08,
 * REN-09 ; ADR 0011, ADR 0013, ADR 0014, ADR 0016).
 *
 * - De près, chaque individu est un humain des planches (src/render/humans.ts), à sa position
 *   de l'instant affiché (app/frames.ts), au niveau de motifs et à la densité k de la vue, les
 *   mêmes pour tous ses individus : un pixel de motif fait k × k pixels physiques, à une
 *   position entière de l'écran, en échantillonnage au plus proche (crowd.ts, layoutCrowd). Il
 *   montre l'image de son animation à la cadence du rendu, figée en pause, et se retourne pour
 *   aller vers l'est ; le nourrisson porté se dessine contre sa mère.
 * - De loin, une bannière par groupe, aux couleurs du premier tissu de la tenue de sa culture,
 *   à la densité de la carte : sa taille à l'écran passe par celle de son motif (chooseBanner).
 *
 * Les humains sont les particules d'un ParticleContainer, peintes par le shader des humains
 * (humanShader.ts) : chacune prend le cadre de son motif dans l'atlas des rôles, et sa palette
 * dans la texture des palettes, où chaque apparence se range une fois, à sa première vue. Tous
 * se dessinent en un appel, sans texture recolorée. Les bannières restent des sprites aux
 * textures recolorées, rangées dans les pages d'un atlas dynamique (pages.ts).
 *
 * Particules et sprites se prennent dans des réserves, dans l'ordre de la profondeur : le i-ième
 * dessine le i-ième dessin, du fond vers l'avant, et PixiJS n'a rien à trier. Le calque est un
 * groupe de rendu de PixiJS : ce qui y change ne fait pas refaire les instructions de la carte.
 * Il mesure ce que coûte chaque image : positions, tri, sprites.
 */
import {
  Container,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Texture,
  type Application,
  type BufferImageSource,
  type Shader,
} from 'pixi.js';
import type { Appearance, Genetics } from '../core/data';
import { geneRoles } from '../core/data/people';
import { GROUP_STRIDE } from '../core/protocol';
import { decodeVisual } from '../core/visual';
import { frameOf, recolor, ROLE, type Palette } from './atlas';
import { parseColor, type Rgb } from './bake';
import { followPalettes, humanShader, PaletteTexture, roleSource, slotColor } from './humanShader';
import {
  ATLAS_ROLES,
  humanAtlas,
  humanPalette,
  humanTable,
  lookParts,
  MOTIF_COUNT,
  motifBox,
} from './humans';
import { bannerFabric } from './looks';
import { TexturePages } from './pages';
import type { Camera, Extent } from './camera';
import {
  CrowdLayout,
  layoutCrowd,
  memberLooks,
  motifTable,
  pickEntity,
  textureParts,
  type CrowdOptions,
  type CrowdSource,
  type HumanTable,
  type MemberLooks,
  type MotifTable,
  type Picked,
} from './crowd';

/**
 * Durée d'une image de la marche, en millisecondes : 420 à ×½ et ×1, et jamais moins de 200,
 * aux vitesses où l'on avance plus vite à l'écran (ADR 0014, § 6).
 */
export const STEP_MS = { slowest: 420, fastest: 200 } as const;

/** Images entre deux comptes des apparences distinctes de l'image. */
const SEEN_EVERY = 16;
/**
 * Les réserves gardent deux fois le pic récent des dessins, plus POOL_SLACK : ce pic perd 1 %
 * par image dessinée (PEAK_DECAY), et la réserve d'une foule passée s'oublie en quelques
 * secondes.
 */
const POOL_SLACK = 64;
const PEAK_DECAY = 0.99;

/** Durée d'une image de la marche à la vitesse de facteur `factor` (SPEED_FACTORS). */
export function stepDuration(factor: number): number {
  return Math.min(STEP_MS.slowest, Math.max(STEP_MS.fastest, STEP_MS.slowest / factor));
}

export interface PeopleData {
  readonly genetics: Genetics;
  readonly appearance: Appearance;
  /** Stature de l'adulte de référence, en cases (display.stature de data/species.json). */
  readonly reference: number;
}

/** Ce que coûte et ce que dessine une image, pour le panneau de débogage. */
export interface PeopleStats {
  /** Durées, en millisecondes : positions et disposition, tri, mise à jour des sprites. */
  readonly positionsMs: number;
  readonly sortMs: number;
  readonly spritesMs: number;
  /** Dessins (individus ou bannières), membres dont la position a été calculée, groupes visibles. */
  readonly drawn: number;
  readonly placed: number;
  readonly groups: number;
  /**
   * Apparences distinctes de l'image (palettes des humains, textures des bannières), apparences
   * gardées, et pages de l'atlas dynamique des bannières.
   */
  readonly textures: number;
  readonly cached: number;
  readonly pages: number;
  /** Niveau de motifs et densité k de la vue rapprochée, −1 de loin. */
  readonly level: number;
  readonly k: number;
  /** Octets des textures du calque : atlas des rôles, palettes, pages des bannières. */
  readonly textureBytes: number;
}

/** Ce que la carte montre de près ou de loin, à l'instant affiché. */
export interface PeopleScene {
  readonly source: CrowdSource;
  /** Instant affiché, en jours, fractionnaire. */
  readonly t: number;
  /** Horloge de la marche du rendu, en millisecondes, et durée d'une image de la marche. */
  readonly walkMs: number;
  readonly stepMs: number;
  /** La case, comptée comme cellIndex, se franchit-elle ? */
  readonly passable: (cell: number) => boolean;
}

/** Palette d'une bannière : son contour, et les tons d'un tissu sur ses rôles d'habit. */
export function bannerPalette(appearance: Appearance, fabric: readonly string[]): Palette {
  const palette: (Rgb | undefined)[] = [];
  palette[ROLE.outline] = parseColor(appearance.outline);
  palette[ROLE.clothLight] = parseColor(fabric[0] ?? appearance.outline);
  palette[ROLE.cloth] = parseColor(fabric[1] ?? appearance.outline);
  palette[ROLE.clothShadow] = parseColor(fabric[2] ?? appearance.outline);
  return palette;
}

export class PeopleLayer {
  private readonly app: Application;
  private readonly layer = new Container({ isRenderGroup: true });
  private readonly data: PeopleData;
  /** Bannières : leur calque, leurs textures recolorées et leurs pages. */
  private readonly banners = new Container();
  private readonly bannerTextures = new Map<number, Texture>();
  private pages = new TexturePages();
  private readonly sprites: Sprite[] = [];
  /** Humains : leurs particules, le cadre de chaque motif, l'atlas des rôles et les palettes. */
  private readonly humans: ParticleContainer<Particle>;
  private readonly particles: Particle[] = [];
  private readonly motifTextures: Texture[];
  private readonly roles: BufferImageSource;
  private palettes = new PaletteTexture();
  /** Le shader des humains, créé au premier dessin d'un rendu WebGL (ensureShader). */
  private shader: Shader | undefined;
  /** Sprites et particules de la dernière image dessinée, et pic récent de leur nombre. */
  private shownSprites = 0;
  private shownParticles = 0;
  private peak = 0;
  /**
   * Ce que montre chaque sprite de bannière : sa clé de texture, et l'identifiant de son
   * étiquette (outils de PixiJS, essais) ; un sprite qui montre la même chose ne se touche pas.
   */
  private shownKeys = new Float64Array(0);
  private shownIds = new Float64Array(0);
  /** L'identifiant de l'individu que montre chaque particule de la dernière image (essais). */
  private particleIds = new Float64Array(0);
  readonly motifs: MotifTable;
  /** La table des humains, vue de la disposition (crowd.ts). */
  private readonly table: HumanTable;
  private readonly hairIds: readonly string[];
  /** Tissu de bannière de chaque culture, compté comme son rang parmi les tissus. */
  private readonly clothOf: CrowdOptions['cloth'];
  private looks: MemberLooks | undefined;
  private readonly layout = new CrowdLayout();
  private readonly seen = new Set<number>();
  /** Images dessinées : les apparences distinctes ne se comptent que toutes les SEEN_EVERY. */
  private draws = 0;
  /** Le compte des apparences distinctes date d'avant la dernière image dessinée. */
  private texturesStale = false;
  /** Ce que montrait la dernière image ; la même vue, au même instant, ne se refait pas. */
  private drawnWith: readonly unknown[] = [];
  /** Version de ce que le calque ne voit pas changer : la franchissabilité des cases. */
  private version = 0;
  /**
   * Version de ce que le calque dessine, augmentée chaque fois qu'il se refait, palettes et
   * pages comprises, ou se vide : la signature de l'image la lit (rendu à la demande, ADR 0010).
   */
  private drawn = 0;
  stats: PeopleStats = {
    positionsMs: 0,
    sortMs: 0,
    spritesMs: 0,
    drawn: 0,
    placed: 0,
    groups: 0,
    textures: 0,
    cached: 0,
    pages: 0,
    level: -1,
    k: 1,
    textureBytes: 0,
  };

  constructor(app: Application, data: PeopleData) {
    this.app = app;
    this.data = data;
    const appearance = data.appearance;
    this.motifs = motifTable(frameOf);
    this.hairIds = (data.genetics.loci[geneRoles(data.genetics).loci.hair]?.alleles ?? []).map(
      (allele) => allele.id,
    );
    this.clothOf = bannerCloth(appearance);
    this.table = humanTable(appearance);
    this.roles = roleSource(ATLAS_ROLES, humanAtlas.width, humanAtlas.height);
    this.motifTextures = Array.from({ length: MOTIF_COUNT }, (_, motif) => {
      const { x, y, width, height } = motifBox(motif);
      return new Texture({ source: this.roles, frame: new Rectangle(x, y, width, height) });
    });
    this.humans = new ParticleContainer<Particle>({
      texture: this.motifTextures[0] ?? Texture.EMPTY,
      dynamicProperties: {
        vertex: false,
        position: false,
        rotation: false,
        uvs: false,
        color: false,
      },
    });
    this.layer.addChild(this.banners, this.humans);
    app.stage.addChild(this.layer);
  }

  /** Texture d'une bannière (textureKey), recolorée à la demande, gardée d'une image à l'autre. */
  private bannerTexture(key: number): Texture {
    const known = this.bannerTextures.get(key);
    if (known !== undefined) return known;
    const { motif, cloth } = textureParts(key);
    const name = this.motifs.names[motif] ?? '';
    const appearance = this.data.appearance;
    const fabric = appearance.fabrics.at(cloth)?.tones ?? [];
    const frame = frameOf(name);
    const texture = this.pages.add(
      recolor(name, bannerPalette(appearance, fabric)),
      frame.width,
      frame.height,
    );
    this.bannerTextures.set(key, texture);
    return texture;
  }

  /**
   * Le programme des humains se compile au premier dessin d'un rendu WebGL, qui seul en a
   * besoin : les essais, sans GPU, disposent et rangent les palettes sans lui.
   */
  private ensureShader(): void {
    if (this.shader !== undefined || !('gl' in this.app.renderer)) return;
    this.shader = humanShader(this.roles, this.palettes);
    this.humans.shader = this.shader;
  }

  /** La place d'une apparence dans la texture des palettes, rangée à sa première vue. */
  private slot(look: number): number {
    return this.palettes.slotOf(look, () =>
      humanPalette(this.data.appearance, this.hairIds, lookParts(look)),
    );
  }

  private sprite(index: number): Sprite {
    let sprite = this.sprites.at(index);
    if (sprite === undefined) {
      sprite = new Sprite();
      this.banners.addChild(sprite);
      this.sprites.push(sprite);
    }
    sprite.visible = true;
    return sprite;
  }

  private particle(index: number): Particle {
    let particle = this.particles.at(index);
    if (particle === undefined) {
      particle = new Particle({ texture: this.motifTextures[0] ?? Texture.EMPTY });
      this.particles.push(particle);
    }
    return particle;
  }

  /** Dessine, depuis la caméra, ce que montre `scene` à son instant. */
  draw(scene: PeopleScene, camera: Camera, viewport: Extent, world: Extent | undefined): void {
    const started = performance.now();
    const { source } = scene;
    const { resolution } = this.app.renderer;
    const frame = world === undefined ? undefined : source.frame;
    // En pause, caméra immobile : la même image, au même instant, rien à refaire.
    const signature = [
      source,
      frame,
      scene.t,
      scene.walkMs,
      scene.stepMs,
      source.applied,
      camera.x,
      camera.y,
      camera.zoom,
      viewport.width,
      viewport.height,
      world?.width,
      resolution,
      this.version,
    ];
    if (signature.every((value, index) => value === this.drawnWith[index])) {
      // Une image inchangée, en pause : le compte des apparences, sauté par la dernière image
      // dessinée, se fait une fois.
      const textures = this.texturesStale ? this.countTextures() : this.stats.textures;
      this.texturesStale = false;
      this.stats = { ...this.stats, positionsMs: 0, sortMs: 0, spritesMs: 0, textures };
      return;
    }
    this.drawnWith = signature;
    this.drawn++;
    this.ensureShader();
    let looks = this.looks;
    if (looks === undefined || looks.frame !== frame) {
      looks = memberLooks(frame, this.table, this.data.reference);
      this.looks = looks;
    }
    const layout = this.layout;
    if (world === undefined || frame === undefined) {
      layout.reset(undefined);
    } else {
      layoutCrowd(layout, source, looks, { camera, viewport, world, resolution }, scene.t, {
        motifs: this.motifs,
        reference: this.data.reference,
        cloth: this.clothOf,
        passable: scene.passable,
        walkMs: scene.walkMs,
        stepMs: scene.stepMs,
      });
    }
    const laid = performance.now();
    layout.sort();
    const sorted = performance.now();
    // Les apparences distinctes, pour le panneau de débogage : une image sur SEEN_EVERY suffit.
    const seen = this.draws++ % SEEN_EVERY === 0 ? this.seen : undefined;
    seen?.clear();
    this.texturesStale = seen === undefined;
    if (this.shownIds.length < layout.count) {
      const size = Math.max(layout.count, this.shownIds.length * 2);
      const ids = new Float64Array(size).fill(Number.NaN);
      const keys = new Float64Array(size).fill(Number.NaN);
      ids.set(this.shownIds);
      keys.set(this.shownKeys);
      this.shownIds = ids;
      this.shownKeys = keys;
    }
    const children = this.humans.particleChildren;
    if (this.particleIds.length < layout.count) {
      this.particleIds = new Float64Array(Math.max(layout.count, this.particleIds.length * 2));
    }
    let people = 0;
    let flags = 0;
    for (let index = 0; index < layout.count; index++) {
      const drawn = layout.drawn(index);
      const look = layout.look[drawn] ?? -1;
      const unit = layout.unit[drawn] ?? 1;
      const left = layout.left[drawn] ?? 0;
      const top = layout.top[drawn] ?? 0;
      if (look >= 0) {
        // Un humain : le cadre de son motif, sa palette, et l'échelle de sa densité, négative
        // pour un motif retourné d'est en ouest autour de son bord droit.
        seen?.add(look);
        const particle = this.particle(people);
        this.particleIds[people] = frame?.ids[layout.member[drawn] ?? 0] ?? 0;
        children[people++] = particle;
        particle.texture = this.motifTextures[layout.texture[drawn] ?? 0] ?? Texture.EMPTY;
        particle.color = slotColor(this.slot(look));
        particle.scaleX = unit / resolution;
        particle.scaleY = Math.abs(unit) / resolution;
        particle.x = (left + (unit < 0 ? (layout.width[drawn] ?? 0) : 0)) / resolution;
        particle.y = top / resolution;
        continue;
      }
      const key = layout.texture[drawn] ?? 0;
      seen?.add(-1 - key);
      const sprite = this.sprite(flags);
      if (this.shownKeys[flags] !== key) {
        this.shownKeys[flags] = key;
        sprite.texture = this.bannerTexture(key);
      }
      sprite.scale.set(unit / resolution);
      sprite.position.set(left / resolution, top / resolution);
      // L'étiquette dit quel groupe la bannière montre, en négatif ; elle ne change qu'avec lui.
      const id = -(frame?.groups[(layout.group[drawn] ?? 0) * GROUP_STRIDE] ?? 0);
      if (this.shownIds[flags] !== id) {
        this.shownIds[flags] = id;
        sprite.label = String(id);
      }
      flags++;
    }
    children.length = people;
    this.humans.update();
    // Ne se cachent que les sprites que montrait la dernière image, et non toute la réserve.
    for (let index = flags; index < this.shownSprites; index++) {
      const unused = this.sprites.at(index);
      if (unused !== undefined) unused.visible = false;
    }
    this.shownSprites = flags;
    this.shownParticles = people;
    this.trimPools(Math.max(flags, people));
    // Les palettes rangées et les bannières recolorées de cette image partent au GPU.
    this.palettes.flush();
    if (this.shader === undefined) this.palettes.release();
    else followPalettes(this.shader, this.palettes);
    this.pages.flush();
    const finished = performance.now();
    this.stats = {
      positionsMs: laid - started,
      sortMs: sorted - laid,
      spritesMs: finished - sorted,
      drawn: layout.count,
      placed: layout.placed,
      groups: layout.visibleGroups,
      textures: seen === undefined ? this.stats.textures : seen.size,
      cached: this.palettes.count + this.bannerTextures.size,
      pages: this.pages.count,
      level: layout.close ? (layout.density?.level ?? -1) : -1,
      k: layout.density?.k ?? 1,
      textureBytes: this.textureBytes(),
    };
  }

  /** Octets des textures du calque, en mémoire et sur le GPU. */
  private textureBytes(): number {
    return this.roles.width * this.roles.height * 4 + this.palettes.bytes + this.pages.bytes;
  }

  /** Apparences distinctes de la dernière image dessinée. */
  private countTextures(): number {
    const { layout, seen } = this;
    seen.clear();
    for (let index = 0; index < layout.count; index++) {
      const drawn = layout.drawn(index);
      const look = layout.look[drawn] ?? -1;
      seen.add(look >= 0 ? look : -1 - (layout.texture[drawn] ?? 0));
    }
    return seen.size;
  }

  /**
   * Détruit les sprites et les particules des réserves au-delà de deux fois le pic récent des
   * dessins, plus POOL_SLACK : après une grande foule, elles ne pèsent plus sur chaque image.
   */
  private trimPools(count: number): void {
    this.peak = Math.max(count, Math.floor(this.peak * PEAK_DECAY));
    const keep = 2 * this.peak + POOL_SLACK;
    if (this.sprites.length > keep) {
      for (const sprite of this.banners.removeChildren(keep)) sprite.destroy();
      this.sprites.length = keep;
      this.shownKeys.fill(Number.NaN, keep);
      this.shownIds.fill(Number.NaN, keep);
    }
    if (this.particles.length > keep) this.particles.length = keep;
  }

  /**
   * Ce que désigne un appui au point (x, y) de l'écran, en pixels physiques, d'après la
   * dernière image dessinée (pickEntity), à `slop` pixels CSS près.
   */
  pick(x: number, y: number, slop: number): Picked | undefined {
    return pickEntity(this.layout, x, y, slop * this.app.renderer.resolution);
  }

  /**
   * Ce que le calque ne voit pas changer a changé : la franchissabilité des cases (pinceau),
   * où se dessinent les nourrissons portés et les bannières. La prochaine image se refait.
   */
  invalidate(): void {
    this.version++;
  }

  /** Version de ce que le calque dessine (rendu à la demande). */
  get drawVersion(): number {
    return this.drawn;
  }

  /** Les individus se voyaient-ils, à la dernière image, plutôt que les bannières ? */
  get close(): boolean {
    return this.layout.close;
  }

  /**
   * Les particules des humains et les sprites des bannières de la dernière image, dans l'ordre
   * du dessin, et l'identifiant de l'individu que montre chaque particule (essais, outils).
   */
  get shown(): {
    readonly particles: readonly Particle[];
    readonly ids: readonly number[];
    readonly sprites: readonly Sprite[];
  } {
    return {
      particles: this.humans.particleChildren.slice(0, this.shownParticles),
      ids: Array.from(this.particleIds.subarray(0, this.shownParticles)),
      sprites: this.sprites.slice(0, this.shownSprites),
    };
  }

  /** Particules et sprites gardés en réserve. */
  get pooled(): { readonly particles: number; readonly sprites: number } {
    return { particles: this.particles.length, sprites: this.sprites.length };
  }

  /** La texture des palettes, telle que la lit le shader (essais). */
  get paletteTexture(): PaletteTexture {
    return this.palettes;
  }

  /**
   * Vide les réserves, les palettes, les textures des bannières et leurs pages (changement de
   * monde : rien ne s'y rattache plus).
   */
  clear(): void {
    for (const sprite of this.banners.removeChildren()) sprite.destroy();
    this.sprites.length = 0;
    this.humans.particleChildren.length = 0;
    this.humans.update();
    this.particles.length = 0;
    this.shownSprites = 0;
    this.shownParticles = 0;
    this.peak = 0;
    for (const texture of this.bannerTextures.values()) texture.destroy(false);
    this.bannerTextures.clear();
    this.pages.destroy();
    this.pages = new TexturePages();
    // Le shader lit la nouvelle texture des palettes avant que l'ancienne ne se libère.
    const previous = this.palettes;
    this.palettes = new PaletteTexture();
    if (this.shader !== undefined) followPalettes(this.shader, this.palettes);
    previous.destroy();
    this.looks = undefined;
    this.layout.reset(undefined);
    this.shownIds.fill(Number.NaN);
    this.shownKeys.fill(Number.NaN);
    this.drawnWith = [];
    this.drawn++;
  }
}

/**
 * Le tissu de la bannière d'un groupe, compté comme son rang parmi les tissus (textureKey) :
 * celui que porte le plus grand nombre de ses membres, d'après le teint de leur code d'apparence
 * (bannerFabric, rechange compris).
 */
export function bannerCloth(appearance: Appearance): CrowdOptions['cloth'] {
  const fabrics = appearance.fabrics.map((fabric) => fabric.id);
  return (culture, codes, first, size) => {
    const skins = function* () {
      for (let member = first; member < first + size; member++) {
        yield decodeVisual(codes[member] ?? 0).skin;
      }
    };
    return Math.max(0, fabrics.indexOf(bannerFabric(appearance, culture, skins())));
  };
}
