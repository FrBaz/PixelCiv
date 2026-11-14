/**
 * Groupes et habitants sur la carte (tâche 2.9 ; REN-03, REN-04, REN-08 ; ADR 0011).
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
 *   culture. Il marche : deux images en alternance.
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

  /** Nouvelle image des groupes, venue du worker. */
  setFrame(frame: GroupsFrame | undefined): void {
    this.frame = frame;
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

  /** Les membres d'un groupe, chacun son mini-sprite, en grappe autour de la case. */
  private drawMembers(
    frame: GroupsFrame,
    first: number,
    size: number,
    culture: number,
    screenX: number,
    screenY: number,
    scale: number,
    now: number,
    used: number,
  ): number {
    const { resolution } = this.app.renderer;
    const cloth = this.cloth(culture);
    let next = used;
    for (let member = 0; member < size; member++) {
      const code = frame.sprites[first + member] ?? 0;
      const visual = decodeVisual(code);
      const step = Math.floor(now / STEP_MS + member * 0.37) % 2;
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
      // Les pieds sur la case, les pixels du sprite sur ceux de la carte.
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
        // Ce qui se dessine autour de la case, grappe ou bannière, en pixels de motif.
        const reach = close
          ? clusterReach(size, this.largest.width, this.largest.height)
          : bannerReach;
        const at = groupScreen(groups[index + 1] ?? 0, groups[index + 2] ?? 0, view, reach, pixel);
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
   * Le groupe dessiné sous le point (x, y) de l'écran, en pixels physiques, d'après la
   * dernière image des groupes et la caméra du dernier dessin (pickGroup), ou undefined.
   */
  pick(camera: Camera, viewport: Extent, world: Extent | undefined, x: number, y: number) {
    const frame = this.frame;
    if (frame === undefined || world === undefined) return undefined;
    const { resolution } = this.app.renderer;
    const view = { camera, viewport, world, resolution };
    return pickGroup(frame, view, x, y, this.shapes, TOUCH_SLOP * resolution);
  }

  /** Vide les textures (changement de monde : rien ne s'y rattache plus). */
  clear(): void {
    for (const texture of this.textures.values()) texture.destroy(true);
    this.textures.clear();
    this.frame = undefined;
  }
}
