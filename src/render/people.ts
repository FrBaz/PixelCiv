/**
 * Individus et groupes sur la carte (tâches 2.9, 2b.2 et 2b.3 ; REN-03, REN-04, REN-08 ;
 * ADR 0011, ADR 0013, ADR 0014).
 *
 * - De près, chaque individu à sa position de l'instant affiché (app/frames.ts), à la
 *   variante de sa stature et à la densité k de la vue, la même pour tous ses individus :
 *   un pixel de motif fait k × k pixels physiques, à une position entière de l'écran, en
 *   échantillonnage au plus proche (crowd.ts, layoutCrowd). Le marcheur alterne ses deux
 *   images de marche à la cadence du rendu, figée en pause ; le nourrisson porté se dessine
 *   contre sa mère.
 * - De loin, une bannière par groupe, aux couleurs de l'habit de sa culture, à la densité de
 *   la carte : sa taille à l'écran passe par celle de son motif (chooseBanner).
 *
 * Les sprites se prennent dans une réserve, dans l'ordre de la profondeur : le i-ième sprite
 * dessine le i-ième dessin, du fond vers l'avant, et PixiJS n'a rien à trier. Les textures
 * recolorées se gardent d'une image à l'autre, une par motif, variante, apparence et couleur
 * d'habit, rangées dans les pages d'un atlas dynamique (pages.ts) : les individus se
 * dessinent en quelques appels. Le calque mesure ce que coûte chaque image : positions, tri,
 * sprites.
 */
import { Container, Sprite, type Application, type Texture } from 'pixi.js';
import type { Appearance, Genetics } from '../core/data';
import { geneRoles } from '../core/data/people';
import { GROUP_STRIDE } from '../core/protocol';
import { decodeVisual, SKIN_TONES } from '../core/visual';
import {
  alleleColors,
  frameOf,
  greyed,
  hasFrame,
  personPalette,
  recolor,
  skinColor,
  type Palette,
} from './atlas';
import { parseColor, type Rgb } from './bake';
import { TexturePages } from './pages';
import type { Camera, Extent } from './camera';
import {
  CrowdLayout,
  layoutCrowd,
  memberLooks,
  motifTable,
  pickEntity,
  textureParts,
  type CrowdSource,
  type MemberLooks,
  type MotifTable,
  type Picked,
} from './crowd';

/**
 * Durée d'une image de la marche, en millisecondes : 420 à ×½ et ×1, et jamais moins de 200,
 * aux vitesses où l'on avance plus vite à l'écran (ADR 0014, § 6).
 */
export const STEP_MS = { slowest: 420, fastest: 200 } as const;

/** Images entre deux comptes des textures distinctes de l'image. */
const SEEN_EVERY = 16;

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
  /** Sprites dessinés, membres dont la position a été calculée, groupes visibles. */
  readonly drawn: number;
  readonly placed: number;
  readonly groups: number;
  /** Textures distinctes de l'image, textures gardées, et pages de l'atlas dynamique. */
  readonly textures: number;
  readonly cached: number;
  readonly pages: number;
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

export class PeopleLayer {
  private readonly app: Application;
  private readonly layer = new Container();
  private readonly data: PeopleData;
  private readonly hairColors: readonly Rgb[];
  private readonly grey: Rgb;
  private readonly clothing: readonly Rgb[];
  /** Rang de la première couleur de même valeur de chaque habit des données. */
  private readonly clothSlots: readonly number[];
  private readonly textures = new Map<number, Texture>();
  private pages = new TexturePages();
  private readonly sprites: Sprite[] = [];
  /**
   * Ce que montre chaque sprite : sa clé de texture, et l'identifiant de son étiquette (outils
   * de PixiJS, essais) ; un sprite qui montre la même chose ne se touche pas.
   */
  private shownKeys = new Float64Array(0);
  private shownIds = new Float64Array(0);
  readonly motifs: MotifTable;
  private looks: MemberLooks | undefined;
  private readonly layout = new CrowdLayout();
  private readonly seen = new Set<number>();
  /** Images dessinées : les textures distinctes ne se comptent que toutes les SEEN_EVERY. */
  private draws = 0;
  /** Ce que montrait la dernière image ; la même vue, au même instant, ne se refait pas. */
  private drawnWith: readonly unknown[] = [];
  /** Version de ce que le calque ne voit pas changer : la franchissabilité des cases. */
  private version = 0;
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
  };

  constructor(app: Application, data: PeopleData) {
    this.app = app;
    this.data = data;
    this.grey = parseColor(data.appearance.grey);
    // Les couleurs des cheveux : celles des allèles du locus qui en tient le rôle.
    this.hairColors = alleleColors(
      data.genetics.loci[geneRoles(data.genetics).loci.hair],
      this.grey,
    );
    this.clothing = data.appearance.clothing.map((color) => parseColor(color));
    const colors = data.appearance.clothing;
    this.clothSlots = colors.map((color) => colors.indexOf(color));
    this.motifs = motifTable(hasFrame, frameOf);
    app.stage.addChild(this.layer);
  }

  /** Habit d'une culture : le rang de sa couleur (cultureCloth), compté comme textureKey. */
  private readonly cloth = (culture: number): number => {
    const slots = this.clothSlots;
    return slots.length === 0 ? 0 : (slots[(Math.max(1, culture) - 1) % slots.length] ?? 0);
  };

  /** Texture d'une clé (textureKey), recolorée à la demande, gardée d'une image à l'autre. */
  private texture(key: number): Texture {
    const known = this.textures.get(key);
    if (known !== undefined) return known;
    const { motif, code, cloth } = textureParts(key);
    const name = this.motifs.names[motif] ?? '';
    const clothColor = this.clothing[cloth] ?? [120, 90, 60];
    let palette: Palette;
    if (name.startsWith('icons/')) {
      palette = personPalette(this.data.appearance, {
        skin: [0, 0, 0],
        hair: [0, 0, 0],
        cloth: clothColor,
      });
    } else {
      const visual = decodeVisual(code);
      palette = personPalette(this.data.appearance, {
        skin: skinColor(this.data.appearance, (visual.skin + 0.5) / SKIN_TONES),
        hair: greyed(this.hairColors[visual.hair] ?? this.grey, this.grey, visual.grey),
        cloth: clothColor,
      });
    }
    const frame = frameOf(name);
    const texture = this.pages.add(recolor(name, palette), frame.width, frame.height);
    this.textures.set(key, texture);
    return texture;
  }

  private sprite(index: number): Sprite {
    let sprite = this.sprites.at(index);
    if (sprite === undefined) {
      sprite = new Sprite();
      this.layer.addChild(sprite);
      this.sprites.push(sprite);
    }
    sprite.visible = true;
    return sprite;
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
      this.stats = { ...this.stats, positionsMs: 0, sortMs: 0, spritesMs: 0 };
      return;
    }
    this.drawnWith = signature;
    let looks = this.looks;
    if (looks === undefined || looks.frame !== frame) {
      looks = memberLooks(frame, this.motifs, this.data.reference);
      this.looks = looks;
    }
    const layout = this.layout;
    if (world === undefined || frame === undefined) {
      layout.reset(undefined);
    } else {
      layoutCrowd(layout, source, looks, { camera, viewport, world, resolution }, scene.t, {
        motifs: this.motifs,
        reference: this.data.reference,
        cloth: this.cloth,
        passable: scene.passable,
        walkMs: scene.walkMs,
        stepMs: scene.stepMs,
      });
    }
    const laid = performance.now();
    layout.sort();
    const sorted = performance.now();
    // Les textures distinctes, pour le panneau de débogage : une image sur SEEN_EVERY suffit.
    const seen = this.draws++ % SEEN_EVERY === 0 ? this.seen : undefined;
    seen?.clear();
    if (this.shownIds.length < layout.count) {
      const size = Math.max(layout.count, this.shownIds.length * 2);
      const ids = new Float64Array(size).fill(Number.NaN);
      const keys = new Float64Array(size).fill(Number.NaN);
      ids.set(this.shownIds);
      keys.set(this.shownKeys);
      this.shownIds = ids;
      this.shownKeys = keys;
    }
    for (let index = 0; index < layout.count; index++) {
      const drawn = layout.drawn(index);
      const key = layout.texture[drawn] ?? 0;
      seen?.add(key);
      const sprite = this.sprite(index);
      if (this.shownKeys[index] !== key) {
        this.shownKeys[index] = key;
        sprite.texture = this.texture(key);
      }
      sprite.scale.set((layout.unit[drawn] ?? 1) / resolution);
      sprite.position.set(
        (layout.left[drawn] ?? 0) / resolution,
        (layout.top[drawn] ?? 0) / resolution,
      );
      // L'étiquette dit qui le sprite montre : l'identifiant de l'individu, ou, en négatif,
      // celui du groupe d'une bannière ; elle ne change qu'avec lui.
      const member = layout.member[drawn] ?? -1;
      const id =
        member >= 0
          ? (frame?.ids[member] ?? 0)
          : -(frame?.groups[(layout.group[drawn] ?? 0) * GROUP_STRIDE] ?? 0);
      if (this.shownIds[index] !== id) {
        this.shownIds[index] = id;
        sprite.label = member >= 0 ? (looks.labels[member] ?? String(id)) : String(id);
      }
    }
    for (let index = layout.count; index < this.sprites.length; index++) {
      const unused = this.sprites.at(index);
      if (unused !== undefined) unused.visible = false;
    }
    // Les motifs recolorés de cette image partent au GPU avec leurs pages.
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
      cached: this.textures.size,
      pages: this.pages.count,
    };
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

  /** Les individus se voyaient-ils, à la dernière image, plutôt que les bannières ? */
  get close(): boolean {
    return this.layout.close;
  }

  /** Vide les textures et leurs pages (changement de monde : rien ne s'y rattache plus). */
  clear(): void {
    for (const texture of this.textures.values()) texture.destroy(false);
    this.textures.clear();
    this.pages.destroy();
    this.pages = new TexturePages();
    this.looks = undefined;
    this.layout.reset(undefined);
    this.shownIds.fill(Number.NaN);
    this.shownKeys.fill(Number.NaN);
    this.drawnWith = [];
  }
}
