/**
 * Groupes et habitants sur la carte (tâche 2.9 ; REN-03, REN-04, REN-08 ; ADR 0011).
 *
 * - De loin, une bannière par groupe, aux couleurs de l'habit de sa culture, à taille fixe
 *   à l'écran, comme une icône.
 * - De près (à partir de SPRITE_SCALE pixels de l'écran par pixel de carte), un mini-sprite
 *   par membre, rangé en grappe autour de la case du groupe. Il est tiré de l'individu :
 *   sexe, âge, teint, cheveux (gris avec l'âge), habit de la culture. Il est dessiné à la
 *   densité de pixels de la carte, sans mélange (REN-08), à une position entière, et il
 *   marche : deux images en alternance.
 *
 * Les textures recolorées se gardent d'une image à l'autre, une par apparence.
 */
import { BufferImageSource, Container, Sprite, Texture, type Application } from 'pixi.js';
import type { Appearance, Genetics } from '../core/data';
import { GROUP_STRIDE, type GroupsFrame } from '../core/protocol';
import { decodeVisual, SKIN_TONES } from '../core/visual';
import { personPalette, recolor, frameOf, skinColor, type Palette } from './atlas';
import { parseColor, type Rgb } from './bake';
import { displayScale, TILE_PX, type Camera, type Extent } from './camera';
import { clusterOffset, spriteName } from './crowd';

/** Échelle, en pixels physiques par pixel de carte, à partir de laquelle on voit les gens. */
export const SPRITE_SCALE = 3;
/** Taille d'un pixel de bannière à l'écran, en pixels physiques. */
const ICON_SCALE = 2;
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
  private frame: GroupsFrame | undefined;

  constructor(app: Application, data: PeopleData) {
    this.app = app;
    this.data = data;
    const hair = data.genetics.loci.find((locus) => locus.id === 'hair');
    this.hairColors = (hair?.alleles ?? []).map((allele) => parseColor(allele.color ?? '#000000'));
    this.grey = parseColor(data.appearance.grey);
    this.clothing = data.appearance.clothing.map((color) => parseColor(color));
    // Les plus bas à l'écran passent devant.
    this.layer.sortableChildren = true;
    app.stage.addChild(this.layer);
  }

  /** Nouvelle image des groupes, venue du worker. */
  setFrame(frame: GroupsFrame | undefined): void {
    this.frame = frame;
  }

  private cloth(culture: number): Rgb {
    return this.clothing[(Math.max(1, culture) - 1) % this.clothing.length] ?? [120, 90, 60];
  }

  /** Texture d'un motif dans une palette, gardée d'une image à l'autre. */
  private texture(name: string, key: string, palette: () => Palette): Texture {
    const cacheKey = `${name}|${key}`;
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

  /** Une bannière, à taille fixe ; sa hampe se plante sur la case. */
  private drawBanner(culture: number, screenX: number, screenY: number, used: number): number {
    const { resolution } = this.app.renderer;
    const banner = this.sprite(used);
    banner.texture = this.texture('icons/group', `c${String(culture)}`, () =>
      personPalette(this.data.appearance, {
        skin: [0, 0, 0],
        hair: [0, 0, 0],
        cloth: this.cloth(culture),
      }),
    );
    const icon = frameOf('icons/group');
    banner.scale.set(ICON_SCALE / resolution);
    banner.position.set(
      Math.round(screenX) / resolution,
      Math.round(screenY - icon.height * ICON_SCALE) / resolution,
    );
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
    let next = used;
    for (let member = 0; member < size; member++) {
      const code = frame.sprites[first + member] ?? 0;
      const visual = decodeVisual(code);
      const step = Math.floor(now / STEP_MS + member * 0.37) % 2;
      const name = spriteName(visual.age, visual.sex, step);
      const hair = visual.grey ? this.grey : (this.hairColors[visual.hair] ?? this.grey);
      const texture = this.texture(name, `${String(code)}c${String(culture)}`, () =>
        personPalette(this.data.appearance, {
          skin: skinColor(this.data.appearance, (visual.skin + 0.5) / SKIN_TONES),
          hair,
          cloth: this.cloth(culture),
        }),
      );
      const person = this.sprite(next++);
      person.texture = texture;
      const offset = clusterOffset(member);
      const shape = frameOf(name);
      // Les pieds sur la case, les pixels du sprite sur ceux de la carte.
      const left = Math.round(screenX + (offset.dx - Math.floor(shape.width / 2)) * scale);
      const top = Math.round(screenY + (offset.dy - shape.height + 2) * scale);
      person.scale.set(scale / resolution);
      person.position.set(left / resolution, top / resolution);
      person.zIndex = top + shape.height * scale;
    }
    return next;
  }

  /** Dessine les groupes visibles depuis la caméra. */
  draw(camera: Camera, viewport: Extent, world: Extent | undefined, now: number): void {
    const frame = this.frame;
    let used = 0;
    if (frame !== undefined && world !== undefined) {
      const scale = displayScale(camera.zoom);
      const close = scale >= SPRITE_SCALE;
      const margin = 16 * Math.max(scale, ICON_SCALE);
      // Largeur d'une copie du monde à l'écran : quand le monde est plus étroit que l'écran,
      // chaque groupe se voit dans chacune des copies visibles (monde cylindrique).
      const span = world.width * scale;
      const reach = Math.ceil((viewport.width / 2 + margin) / span);
      const groups = frame.groups;
      let first = 0;
      for (let index = 0; index + GROUP_STRIDE <= groups.length; index += GROUP_STRIDE) {
        const x = groups[index + 1] ?? 0;
        const y = groups[index + 2] ?? 0;
        const size = groups[index + 3] ?? 0;
        const culture = groups[index + 4] ?? 1;
        // Centre de la case, dans la copie du monde la plus proche de la caméra.
        let mapX = x * TILE_PX + TILE_PX / 2;
        const mapY = y * TILE_PX + TILE_PX / 2;
        mapX += Math.round((camera.x - mapX) / world.width) * world.width;
        const nearest = (mapX - camera.x) * scale + viewport.width / 2;
        const screenY = (mapY - camera.y) * scale + viewport.height / 2;
        if (screenY > -margin && screenY < viewport.height + margin) {
          for (let copy = -reach; copy <= reach; copy++) {
            const screenX = nearest + copy * span;
            if (screenX <= -margin || screenX >= viewport.width + margin) continue;
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
              used = this.drawBanner(culture, screenX, screenY, used);
            }
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

  /** Vide les textures (changement de monde : rien ne s'y rattache plus). */
  clear(): void {
    for (const texture of this.textures.values()) texture.destroy(true);
    this.textures.clear();
    this.frame = undefined;
  }
}
