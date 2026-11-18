/**
 * Groupes et habitants sur la carte (tâches 2.9 et 2b.2 ; REN-03, REN-04, REN-08 ;
 * ADR 0011, ADR 0013).
 *
 * Tout se dessine à la densité de pixels de la carte, sans mélange (REN-08), à des
 * positions entières : à l'échelle s, entière à partir de 1, s pixels physiques par pixel
 * de motif, un par pixel de carte ; sous l'échelle 1, un pixel physique par pixel de
 * motif, comme la carte que montrent ses mipmaps (mapPixel, crowd.ts).
 *
 * - De loin, une bannière par groupe, aux couleurs de l'habit de sa culture. Sa taille à
 *   l'écran passe par celle de son motif, et non par celle de ses pixels : la plus petite
 *   des bannières de 8 à 36 pixels de haut qui atteigne 12 pixels CSS (chooseBanner).
 * - De près (à partir de SPRITE_SCALE pixels de l'écran par pixel de carte), un mini-sprite
 *   par membre, rangé en grappe autour de la case du groupe. Il est tiré de l'individu :
 *   sexe, âge, teint, cheveux (grisonnants avec l'âge, comme au portrait), habit de la
 *   culture. Il marche, deux images en alternance, tant que son groupe est en route ; au
 *   camp, il se tient sur la première.
 * - Chaque groupe se tient à sa position de l'instant affiché (show), en marche sur son
 *   chemin, entre les cases : un sprite quitte alors la grille des pixels de la carte, mais
 *   reste à une position entière de pixels physiques, et un pixel de son motif reste un
 *   pixel de carte.
 *
 * Un groupe se dessine s'il touche l'écran, grappe ou bannière comprise. Chaque sprite a
 * une profondeur unique (depth, crowd.ts) : le plus bas à l'écran passe devant, puis le
 * dernier dessiné, comme le retrouve pickGroup. Les textures recolorées se gardent d'une
 * image à l'autre, une par motif, apparence et couleur d'habit.
 */
import { BufferImageSource, Container, Sprite, Texture, type Application } from 'pixi.js';
import type { Appearance, Genetics } from '../core/data';
import { geneRoles } from '../core/data/people';
import { GROUP_STRIDE, type GroupsFrame } from '../core/protocol';
import type { WorldSize } from '../core/world';
import { decodeVisual, SKIN_TONES } from '../core/visual';
import {
  alleleColors,
  cultureCloth,
  greyed,
  personPalette,
  recolor,
  frameOf,
  skinColor,
  type Palette,
} from './atlas';
import { parseColor, type Rgb } from './bake';
import { displayScale, type Camera, type Extent } from './camera';
import {
  bannerBox,
  bannerShapes,
  chooseBanner,
  clusterReach,
  depth,
  groupPositions,
  groupScreen,
  mapPixel,
  memberBox,
  memberShape,
  onScreen,
  pickGroup,
  spriteName,
  spriteNames,
  SPRITE_SCALE,
  textureKey,
  TOUCH_SLOP,
  type NamedSize,
  type PickShapes,
  type Reach,
} from './crowd';

/** Durée d'une image de la marche, en millisecondes. */
const STEP_MS = 420;

export interface PeopleData {
  readonly genetics: Genetics;
  readonly appearance: Appearance;
}

export class PeopleLayer {
  private readonly app: Application;
  private readonly layer = new Container();
  private readonly data: PeopleData;
  private readonly hairColors: readonly Rgb[];
  private readonly grey: Rgb;
  private readonly clothing: readonly Rgb[];
  private readonly textures = new Map<string, Texture>();
  private readonly sprites: Sprite[] = [];
  /** Le plus grand des mini-sprites, pour l'étendue d'une grappe. */
  private readonly largest: { readonly width: number; readonly height: number };
  /** Les bannières, de la plus petite à la plus grande (BANNERS). */
  private readonly banners: readonly [NamedSize, ...NamedSize[]];
  /** Les motifs, pour retrouver le groupe sous un appui. */
  private readonly shapes: PickShapes;
  private frame: GroupsFrame | undefined;
  /** Position de chaque groupe à l'instant affiché, en cases, et s'il marche encore. */
  private positions = new Float64Array(0);
  private moving = new Uint8Array(0);

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
    const frames = spriteNames().map((name) => frameOf(name));
    this.largest = {
      width: Math.max(...frames.map((frame) => frame.width)),
      height: Math.max(...frames.map((frame) => frame.height)),
    };
    this.banners = bannerShapes(frameOf);
    this.shapes = {
      banners: this.banners,
      largest: this.largest,
      member: (code) => memberShape(code, frameOf),
    };
    // Les sprites se rangent par leur profondeur (depth) : le plus bas devant.
    this.layer.sortableChildren = true;
    app.stage.addChild(this.layer);
  }

  /**
   * L'image des groupes de l'instant affiché, et leur position au jour `k` du mois de ses
   * marches, fractionnaire (groupPositions) : walkOf donne l'indice de la marche de chaque
   * groupe qui en a une. Sans image, rien ne se dessine.
   */
  show(
    frame: GroupsFrame | undefined,
    walkOf: ReadonlyMap<number, number>,
    k: number,
    width: number,
  ): void {
    this.frame = frame;
    if (frame === undefined) return;
    const count = Math.floor(frame.groups.length / GROUP_STRIDE);
    if (this.moving.length !== count) {
      this.positions = new Float64Array(count * 2);
      this.moving = new Uint8Array(count);
    }
    groupPositions(frame, walkOf, k, width, this.positions, this.moving);
  }

  /** Cases où se tiennent les groupes dessinés, comptées comme cellIndex. */
  occupiedCells(size: WorldSize): Set<number> {
    return positionCells(this.frame === undefined ? new Float64Array(0) : this.positions, size);
  }

  private cloth(culture: number): Rgb {
    return cultureCloth(this.clothing, culture) ?? [120, 90, 60];
  }

  /** Texture d'un motif dans une palette, gardée d'une image à l'autre. */
  private texture(name: string, cacheKey: string, palette: () => Palette): Texture {
    let texture = this.textures.get(cacheKey);
    if (texture === undefined) {
      const frame = frameOf(name);
      const source = new BufferImageSource({
        resource: recolor(name, palette()),
        width: frame.width,
        height: frame.height,
        scaleMode: 'nearest',
      });
      texture = new Texture({ source });
      this.textures.set(cacheKey, texture);
    }
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

  /**
   * La bannière `banner` d'un groupe, de `pixel` pixels physiques par pixel de son motif ;
   * sa hampe se plante sur la case. À l'échelle 1 et au-delà, ses pixels tombent sur ceux
   * de la carte : la case et la bannière sont à des positions entières de pixels de carte.
   */
  private drawBanner(
    banner: NamedSize,
    culture: number,
    screenX: number,
    screenY: number,
    pixel: number,
    used: number,
  ): number {
    const { resolution } = this.app.renderer;
    const sprite = this.sprite(used);
    const cloth = this.cloth(culture);
    sprite.texture = this.texture(banner.name, textureKey(banner.name, 0, cloth), () =>
      personPalette(this.data.appearance, { skin: [0, 0, 0], hair: [0, 0, 0], cloth }),
    );
    const box = bannerBox(screenX, screenY, banner, pixel);
    sprite.scale.set(pixel / resolution);
    sprite.position.set(box.left / resolution, box.top / resolution);
    sprite.zIndex = depth(box, used);
    return used + 1;
  }

  /**
   * Les membres d'un groupe, chacun son mini-sprite, en grappe autour de sa position ; ils
   * marchent si `moving`, sinon se tiennent sur la première image de leur marche.
   */
  private drawMembers(
    frame: GroupsFrame,
    first: number,
    size: number,
    culture: number,
    screenX: number,
    screenY: number,
    scale: number,
    now: number,
    moving: boolean,
    used: number,
  ): number {
    const { resolution } = this.app.renderer;
    const cloth = this.cloth(culture);
    let next = used;
    for (let member = 0; member < size; member++) {
      const code = frame.sprites[first + member] ?? 0;
      const visual = decodeVisual(code);
      const step = moving ? Math.floor(now / STEP_MS + member * 0.37) % 2 : 0;
      const name = spriteName(visual.age, visual.sex, step);
      const hair = greyed(this.hairColors[visual.hair] ?? this.grey, this.grey, visual.grey);
      const texture = this.texture(name, textureKey(name, code, cloth), () =>
        personPalette(this.data.appearance, {
          skin: skinColor(this.data.appearance, (visual.skin + 0.5) / SKIN_TONES),
          hair,
          cloth,
        }),
      );
      const rank = next++;
      const person = this.sprite(rank);
      person.texture = texture;
      // Les pieds sur la position du groupe, chaque pixel du sprite un pixel de carte.
      const box = memberBox(screenX, screenY, member, frameOf(name), scale);
      person.scale.set(scale / resolution);
      person.position.set(box.left / resolution, box.top / resolution);
      person.zIndex = depth(box, rank);
    }
    return next;
  }

  /** Dessine les groupes visibles depuis la caméra. */
  draw(camera: Camera, viewport: Extent, world: Extent | undefined, now: number): void {
    const frame = this.frame;
    let used = 0;
    if (frame !== undefined && world !== undefined) {
      const { resolution } = this.app.renderer;
      const view = { camera, viewport, world, resolution };
      const scale = displayScale(camera.zoom);
      const close = scale >= SPRITE_SCALE;
      // Pixels physiques par pixel de motif, mini-sprite ou bannière : ceux de la carte.
      const pixel = mapPixel(scale);
      const banner = chooseBanner(this.banners, pixel, resolution);
      const bannerReach: Reach = { left: 0, right: banner.width, up: banner.height, down: 0 };
      const groups = frame.groups;
      let first = 0;
      for (let index = 0; index + GROUP_STRIDE <= groups.length; index += GROUP_STRIDE) {
        const size = groups[index + 3] ?? 0;
        const culture = groups[index + 4] ?? 1;
        const group = index / GROUP_STRIDE;
        // Ce qui se dessine autour du groupe, grappe ou bannière, en pixels de motif.
        const reach = close
          ? clusterReach(size, this.largest.width, this.largest.height)
          : bannerReach;
        const at = groupScreen(
          this.positions[group * 2] ?? 0,
          this.positions[group * 2 + 1] ?? 0,
          view,
          reach,
          pixel,
        );
        const screenY = at.y;
        for (let copy = -at.copies; copy <= at.copies; copy++) {
          const screenX = at.x + copy * at.span;
          if (!onScreen(screenX, screenY, reach, pixel, viewport)) continue;
          if (close) {
            used = this.drawMembers(
              frame,
              first,
              size,
              culture,
              screenX,
              screenY,
              pixel,
              now,
              this.moving[group] === 1,
              used,
            );
          } else {
            used = this.drawBanner(banner, culture, screenX, screenY, pixel, used);
          }
        }
        first += size;
      }
    }
    for (let index = used; index < this.sprites.length; index++) {
      const unused = this.sprites.at(index);
      if (unused !== undefined) unused.visible = false;
    }
  }

  /**
   * Le groupe dessiné sous le point (x, y) de l'écran, en pixels physiques, d'après l'image
   * des groupes et les positions du dernier dessin, et la caméra (pickGroup), ou undefined.
   */
  pick(camera: Camera, viewport: Extent, world: Extent | undefined, x: number, y: number) {
    const frame = this.frame;
    if (frame === undefined || world === undefined) return undefined;
    const { resolution } = this.app.renderer;
    const view = { camera, viewport, world, resolution };
    return pickGroup(frame, this.positions, view, x, y, this.shapes, TOUCH_SLOP * resolution);
  }

  /** Vide les textures (changement de monde : rien ne s'y rattache plus). */
  clear(): void {
    for (const texture of this.textures.values()) texture.destroy(true);
    this.textures.clear();
    this.frame = undefined;
  }
}

/**
 * Cases où tombent des positions de groupes (deux nombres par groupe, en cases), comptées
 * comme cellIndex : la case (x, y) couvre [x, x + 1[ × [y, y + 1[.
 */
export function positionCells(positions: Float64Array, size: WorldSize): Set<number> {
  const cells = new Set<number>();
  for (let rank = 0; rank * 2 + 1 < positions.length; rank++) {
    const x = Math.floor(positions[rank * 2] ?? 0);
    const y = Math.floor(positions[rank * 2 + 1] ?? 0);
    if (y < 0 || y >= size.height) continue;
    cells.add(y * size.width + (((x % size.width) + size.width) % size.width));
  }
  return cells;
}
