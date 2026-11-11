/**
 * Groupes et habitants sur la carte (tâche 2.9 ; REN-03, REN-04, REN-08 ; ADR 0011).
 *
 * - De loin, une bannière par groupe, aux couleurs de l'habit de sa culture. Elle est à la
 *   densité de la carte quand l'échelle le permet ; plus loin, c'est un marqueur
 *   d'interface, de taille fixe en pixels CSS (iconPixel, crowd.ts).
 * - De près (à partir de SPRITE_SCALE pixels de l'écran par pixel de carte), un mini-sprite
 *   par membre, rangé en grappe autour de la case du groupe. Il est tiré de l'individu :
 *   sexe, âge, teint, cheveux (gris avec l'âge), habit de la culture. Il est dessiné à la
 *   densité de pixels de la carte, sans mélange (REN-08), à une position entière, et il
 *   marche : deux images en alternance.
 *
 * Un groupe se dessine s'il touche l'écran, grappe ou bannière comprise. Les textures
 * recolorées se gardent d'une image à l'autre, une par apparence et par couleur d'habit.
 */
import { BufferImageSource, Container, Sprite, Texture, type Application } from 'pixi.js';
import type { Appearance, Genetics } from '../core/data';
import { GROUP_STRIDE, type GroupsFrame } from '../core/protocol';
import { decodeVisual, SKIN_TONES } from '../core/visual';
import {
  cultureCloth,
  personPalette,
  recolor,
  frameOf,
  skinColor,
  type Frame,
  type Palette,
} from './atlas';
import { parseColor, type Rgb } from './bake';
import { displayScale, type Camera, type Extent } from './camera';
import {
  bannerBox,
  clusterReach,
  groupScreen,
  iconPixel,
  memberBox,
  memberShape,
  onScreen,
  pickGroup,
  spriteName,
  spriteNames,
  SPRITE_SCALE,
  textureKey,
  TOUCH_SLOP,
  type PickShapes,
  type Reach,
} from './crowd';

/** Motif de la bannière d'un groupe. */
const BANNER = 'icons/group';
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
  /** La bannière, et son étendue autour du pied de sa hampe, en pixels d'icône. */
  private readonly bannerFrame: Frame;
  private readonly bannerReach: Reach;
  /** Les motifs, pour retrouver le groupe sous un appui. */
  private readonly shapes: PickShapes;
  private frame: GroupsFrame | undefined;

  constructor(app: Application, data: PeopleData) {
    this.app = app;
    this.data = data;
    const hair = data.genetics.loci.find((locus) => locus.id === 'hair');
    this.hairColors = (hair?.alleles ?? []).map((allele) => parseColor(allele.color ?? '#000000'));
    this.grey = parseColor(data.appearance.grey);
    this.clothing = data.appearance.clothing.map((color) => parseColor(color));
    const frames = spriteNames().map((name) => frameOf(name));
    this.largest = {
      width: Math.max(...frames.map((frame) => frame.width)),
      height: Math.max(...frames.map((frame) => frame.height)),
    };
    this.bannerFrame = frameOf(BANNER);
    this.bannerReach = {
      left: 0,
      right: this.bannerFrame.width,
      up: this.bannerFrame.height,
      down: 0,
    };
    this.shapes = {
      banner: this.bannerFrame,
      largest: this.largest,
      member: (code) => memberShape(code, frameOf),
    };
    // Les plus bas à l'écran passent devant.
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
   * Une bannière, de `pixel` pixels physiques par pixel d'icône ; sa hampe se plante sur
   * la case. À la densité de la carte, ses pixels tombent sur ceux de la carte : la case
   * et la bannière sont à des positions entières de pixels de carte.
   */
  private drawBanner(
    culture: number,
    screenX: number,
    screenY: number,
    pixel: number,
    used: number,
  ): number {
    const { resolution } = this.app.renderer;
    const banner = this.sprite(used);
    const cloth = this.cloth(culture);
    banner.texture = this.texture(BANNER, textureKey(BANNER, 0, cloth), () =>
      personPalette(this.data.appearance, { skin: [0, 0, 0], hair: [0, 0, 0], cloth }),
    );
    const box = bannerBox(screenX, screenY, this.bannerFrame, pixel);
    banner.scale.set(pixel / resolution);
    banner.position.set(box.left / resolution, box.top / resolution);
    banner.zIndex = screenY;
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
      const hair = visual.grey ? this.grey : (this.hairColors[visual.hair] ?? this.grey);
      const texture = this.texture(name, textureKey(name, code, cloth), () =>
        personPalette(this.data.appearance, {
          skin: skinColor(this.data.appearance, (visual.skin + 0.5) / SKIN_TONES),
          hair,
          cloth,
        }),
      );
      const person = this.sprite(next++);
      person.texture = texture;
      // Les pieds sur la case, les pixels du sprite sur ceux de la carte.
      const box = memberBox(screenX, screenY, member, frameOf(name), scale);
      person.scale.set(scale / resolution);
      person.position.set(box.left / resolution, box.top / resolution);
      person.zIndex = box.top + box.height;
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
      // Pixels physiques par pixel de bannière : la densité de la carte, si elle le permet.
      const icon = iconPixel(scale, resolution);
      const groups = frame.groups;
      let first = 0;
      for (let index = 0; index + GROUP_STRIDE <= groups.length; index += GROUP_STRIDE) {
        const size = groups[index + 3] ?? 0;
        const culture = groups[index + 4] ?? 1;
        // Ce qui se dessine autour de la case, grappe ou bannière, en unités de `unit`
        // pixels physiques.
        const reach = close
          ? clusterReach(size, this.largest.width, this.largest.height)
          : this.bannerReach;
        const unit = close ? scale : icon;
        const at = groupScreen(groups[index + 1] ?? 0, groups[index + 2] ?? 0, view, reach, unit);
        const screenY = at.y;
        for (let copy = -at.copies; copy <= at.copies; copy++) {
          const screenX = at.x + copy * at.span;
          if (!onScreen(screenX, screenY, reach, unit, viewport)) continue;
          if (close) {
            used = this.drawMembers(
              frame,
              first,
              size,
              culture,
              screenX,
              screenY,
              scale,
              now,
              used,
            );
          } else {
            used = this.drawBanner(culture, screenX, screenY, icon, used);
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
