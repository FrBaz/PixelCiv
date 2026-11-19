/**
 * Atlas des humains des planches (tâche 2b.5 ; AST-02, AST-04, REN-04, REN-09 ; ADR 0016).
 *
 * Au build, et au lancement du serveur de développement, ce module lit les deux planches de
 * base de sprites/humans/skin/ (data/humans.json), et les grilles de régions du corps
 * d'assets/humans/regions/. Il en tire une image de rôles par image d'animation (src/gen/
 * humans.ts) : chaque pixel de peau ou de sous-vêtement y devient sa région et son rang, chaque
 * autre ton un rôle gardé. Puis les niveaux réduits, leurs variantes de hauteur, et les enfants
 * et nourrissons composés. Le tout se range dans un atlas de rôles, que le jeu reçoit par le
 * module virtuel « virtual:human-atlas » et recolore à l'exécution (src/render/humans.ts) :
 * aucune couleur n'y est calculée, chaque rôle prend un ton de la planche ou d'une rampe des
 * données.
 *
 * Le jeu ne range que les animations montrées (data/humans.json, shown) ; les tests demandent
 * aussi les autres (animations: 'all'), que le build lit et vérifie toutes. Le build échoue si
 * une grille contredit sa planche, si une tenue de data/appearance.json laisse voir le
 * sous-vêtement des planches, ou si CREDITS.md ne cite pas le pack (ADR 0008).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePath, type Plugin } from 'vite';
import { z } from 'zod';
import {
  BODY_KINDS,
  HumansSchema,
  OutfitSchema,
  type BodyKind,
  type Humans,
  type Outfit,
} from '../src/core/data/humans.ts';
import {
  cellRoles,
  eyeRoles,
  figureRows,
  keptTones,
  parseRegionGrids,
  RECOLOR,
  reduceRoles,
  roleParts,
  toneKinds,
  trimRoles,
  youngRoles,
  type OutlineMode,
  type RoleImage,
} from '../src/gen/humans.ts';
import { decodeRgba } from './png.ts';

/** Variantes de hauteur au plus, par niveau (ADR 0014). */
export const MAX_VARIANTS = 3;
/** Côté le plus long de l'atlas, en pixels : ce que WebGL 2 garantit à toute texture. */
export const MAX_ATLAS_SIDE = 2048;
/** Motifs au plus : leurs tables sont en entiers de 16 bits (src/render/humans.ts). */
export const MAX_MOTIFS = 65_535;

export interface HumanAtlas {
  readonly width: number;
  readonly height: number;
  /** Rôles de l'atlas, un octet par pixel, en base64. */
  readonly roles: string;
  /** Six nombres par motif : x, y, largeur, hauteur, et le point des pieds dans le motif. */
  readonly motifs: readonly number[];
  /**
   * Premier motif de chaque (corps, niveau, variante, animation), −1 sans motif :
   * index[((corps × niveaux + niveau) × MAX_VARIANTS + variante) × animations + animation].
   */
  readonly index: readonly number[];
  /** Corps : femme, homme, puis chaque taille d'enfant et de nourrisson (data/humans.json). */
  readonly bodies: readonly string[];
  /** Sorte de chaque corps, pour les tenues. */
  readonly kinds: readonly BodyKind[];
  /** Niveaux : facteur de réduction, rangées de l'adulte de référence, écarts des variantes. */
  readonly levels: readonly { factor: number; rows: number; variants: readonly number[] }[];
  readonly animations: readonly {
    id: string;
    frames: number;
    steps?: number;
    frameMs?: number;
    loop: boolean;
  }[];
  /** Régions, dans l'ordre de leur code ; celle des cheveux. */
  readonly regions: readonly string[];
  readonly hairRegion: number;
  /** Tons gardés, dans l'ordre de leur rôle (KEPT + rang) ; rôles des yeux. */
  readonly kept: readonly string[];
  readonly eyes: readonly number[];
  /** Tons de la peau et du sous-vêtement des planches, par rang. */
  readonly skin: readonly string[];
  readonly under: readonly string[];
  /** Régions où chaque sorte de corps montre du sous-vêtement, que toute tenue couvre. */
  readonly underRegions: Readonly<Record<BodyKind, readonly string[]>>;
  /** Le pack des planches. */
  readonly credit: Humans['credit'];
}

export interface AtlasOptions {
  /** Les animations montrées en jeu (par défaut), ou toutes. */
  readonly animations?: 'shown' | 'all';
}

/** Rangement en étagères, les plus hauts d'abord. */
function pack(
  images: readonly RoleImage[],
  width = 1024,
): { width: number; height: number; at: { x: number; y: number }[] } {
  const order = images
    .map((_, index) => index)
    .sort((a, b) => (images[b]?.height ?? 0) - (images[a]?.height ?? 0) || a - b);
  const at: { x: number; y: number }[] = new Array<{ x: number; y: number }>(images.length);
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const index of order) {
    const image = images[index];
    if (x + image.width > width) {
      x = 0;
      y += shelf + 1;
      shelf = 0;
    }
    at[index] = { x, y };
    x += image.width + 1;
    shelf = Math.max(shelf, image.height);
  }
  return { width, height: y + shelf, at };
}

/** Images de rôles d'un sexe, par animation de data/humans.json et par image. */
export function sheetFrames(root: string, humans: Humans, sex: 'female' | 'male'): RoleImage[][] {
  const { cell, tones } = humans;
  const kinds = toneKinds(tones);
  const letters = humans.regions.map((region) => region.letter).join('');
  const { width, rgba } = decodeRgba(readFileSync(join(root, humans.sheets[sex])));
  return humans.animations.map((animation) => {
    const file = join('assets/humans/regions', sex, `${animation.id}.txt`);
    const grids = parseRegionGrids(
      file,
      readFileSync(join(root, file), 'utf8'),
      cell.width,
      cell.height,
      letters,
    );
    if (grids.frames.length !== animation.frames) {
      throw new Error(
        `${file} : ${String(grids.frames.length)} images au lieu de ${String(animation.frames)}`,
      );
    }
    return grids.frames.map((grid, frame) =>
      cellRoles(
        `${humans.sheets[sex]}, ${animation.id} ${String(frame)}`,
        rgba,
        width,
        frame * cell.width,
        animation.row * cell.height,
        cell.width,
        cell.height,
        cell.anchor,
        grid,
        kinds,
        letters,
      ),
    );
  });
}

/** Construit l'atlas des humains depuis la racine du dépôt. */
export function buildHumanAtlas(
  root: string,
  humans: Humans = loadHumans(root),
  options: AtlasOptions = {},
): HumanAtlas {
  const { tones } = humans;
  const eyes = eyeRoles(tones);
  const sexes = ['female', 'male'] as const;
  const head = humans.regions.flatMap((region, index) => (region.head === true ? [index] : []));
  const every = options.animations === 'all';
  const chosen = humans.animations.flatMap((animation, index) =>
    every || animation.shown ? [index] : [],
  );
  const shown = humans.animations.flatMap((animation, index) => (animation.shown ? [index] : []));
  // Images de rôles de chaque sexe, par animation et par image.
  const frames = {
    female: sheetFrames(root, humans, 'female'),
    male: sheetFrames(root, humans, 'male'),
  };
  const bodies = [
    ...sexes,
    ...humans.young.child.map((_, index) => `child-${String(index)}`),
    ...humans.young.baby.map((_, index) => `baby-${String(index)}`),
  ];
  const kinds: BodyKind[] = [
    ...sexes,
    ...humans.young.child.map((): BodyKind => 'child'),
    ...humans.young.baby.map((): BodyKind => 'baby'),
  ];
  const young = [...humans.young.child, ...humans.young.baby];
  const A = chosen.length;
  const L = humans.levels.length;
  const images: RoleImage[] = [];
  const owners: number[] = [];
  const index = new Array<number>(bodies.length * L * MAX_VARIANTS * A).fill(-1);
  const slot = (body: number, level: number, variant: number, animation: number) =>
    ((body * L + level) * MAX_VARIANTS + variant) * A + animation;
  const reference = (sex: 'female' | 'male') => {
    const idle = frames[sex].at(0)?.at(0);
    if (idle === undefined) throw new Error(`${sex} : aucune image de repos`);
    return figureRows(idle);
  };
  const levels = humans.levels.map((level) => ({
    factor: level.factor,
    rows: Math.round(reference('male') / level.factor),
    variants: level.variants,
  }));
  humans.levels.forEach((level, l) => {
    const outline: OutlineMode = level.outline;
    sexes.forEach((sex, body) => {
      const ref = reference(sex);
      level.variants.forEach((offset, variant) => {
        const rows = Math.round(ref / level.factor) + offset;
        const factor = level.factor === 1 && offset === 0 ? 1 : ref / rows;
        chosen.forEach((animation, a) => {
          index[slot(body, l, variant, a)] = images.length;
          for (const image of frames[sex][animation] ?? []) {
            images.push(trimRoles(reduceRoles(image, factor, outline, eyes)));
            owners.push(body);
          }
        });
      });
    });
    young.forEach((size, offset) => {
      const body = sexes.length + offset;
      const rows = Math.max(4, Math.round(size.rows / level.factor));
      const heads = Math.max(2, Math.round(size.head / level.factor));
      const mode: OutlineMode = outline === 'keep' ? 'thick' : outline;
      chosen.forEach((animation, a) => {
        // Les enfants composés n'ont que les animations montrées en jeu.
        if (!shown.includes(animation)) return;
        index[slot(body, l, 0, a)] = images.length;
        for (const image of frames[humans.young.body][animation] ?? []) {
          images.push(trimRoles(youngRoles(image, rows, heads, mode, eyes, head)));
          owners.push(body);
        }
      });
    });
  });
  if (images.length > MAX_MOTIFS) {
    throw new Error(
      `atlas des humains : ${String(images.length)} motifs, ${String(MAX_MOTIFS)} au plus`,
    );
  }
  // Régions où chaque sorte de corps montre du sous-vêtement : à toutes ses images, y compris
  // celles des animations que le jeu ne range pas encore.
  const under: Record<BodyKind, Set<number>> = {
    female: new Set(),
    male: new Set(),
    child: new Set(),
    baby: new Set(),
  };
  const collect = (image: RoleImage, kind: BodyKind) => {
    for (const role of image.roles) {
      if (role < RECOLOR) continue;
      const parts = roleParts(role);
      if (parts.source === 1) under[kind].add(parts.region);
    }
  };
  for (const sex of sexes) {
    for (const animation of frames[sex]) for (const image of animation) collect(image, sex);
  }
  images.forEach((image, i) => {
    collect(image, kinds[owners[i] ?? 0] ?? 'male');
  });
  const { width, height, at } = pack(images);
  if (height > MAX_ATLAS_SIDE) {
    throw new Error(
      `atlas des humains : ${String(height)} rangées, ${String(MAX_ATLAS_SIDE)} au plus`,
    );
  }
  const roles = new Uint8Array(width * height);
  const motifs: number[] = [];
  images.forEach((image, i) => {
    const { x, y } = at[i] ?? { x: 0, y: 0 };
    for (let row = 0; row < image.height; row++) {
      roles.set(
        image.roles.subarray(row * image.width, (row + 1) * image.width),
        (y + row) * width + x,
      );
    }
    motifs.push(x, y, image.width, image.height, image.anchorX, image.anchorY);
  });
  const regionIds = humans.regions.map((region) => region.id);
  const underRegions = Object.fromEntries(
    BODY_KINDS.map((kind) => [
      kind,
      [...under[kind]].sort((a, b) => a - b).map((region) => regionIds[region] ?? ''),
    ]),
  ) as Record<BodyKind, string[]>;
  return {
    width,
    height,
    roles: Buffer.from(roles).toString('base64'),
    motifs,
    index,
    bodies,
    kinds,
    levels,
    animations: chosen.map((animation) => {
      const a = humans.animations[animation];
      return {
        id: a.id,
        frames: a.frames,
        ...(a.steps === undefined ? {} : { steps: a.steps }),
        ...(a.frameMs === undefined ? {} : { frameMs: a.frameMs }),
        loop: a.loop,
      };
    }),
    regions: regionIds,
    hairRegion: humans.regions.findIndex((region) => region.hair === true),
    kept: keptTones(tones),
    eyes,
    skin: [...tones.skin],
    under: [...tones.under],
    underRegions,
    credit: humans.credit,
  };
}

export function loadHumans(root: string): Humans {
  return HumansSchema.parse(JSON.parse(readFileSync(join(root, 'data/humans.json'), 'utf8')));
}

/** Les tenues de data/appearance.json, que le build confronte au sous-vêtement des planches. */
export function loadOutfits(root: string): Outfit[] {
  const appearance: unknown = JSON.parse(readFileSync(join(root, 'data/appearance.json'), 'utf8'));
  return z.object({ outfits: z.array(OutfitSchema) }).parse(appearance).outfits;
}

/**
 * Ce que le build refuse des tenues : une sorte de corps qui laisse nue une région où ses
 * planches montrent du sous-vêtement. Une ligne par manque, aucune si tout va bien.
 */
export function uncoveredUnderwear(atlas: HumanAtlas, outfits: readonly Outfit[]): string[] {
  const problems: string[] = [];
  for (const outfit of outfits) {
    for (const kind of BODY_KINDS) {
      const covered = new Set(outfit[kind].flatMap((piece) => piece.regions));
      for (const region of atlas.underRegions[kind]) {
        if (!covered.has(region)) {
          problems.push(
            `tenue ${outfit.id} (${kind}) : sous-vêtement des planches nu, région ${region}`,
          );
        }
      }
    }
  }
  return problems;
}

/** CREDITS.md cite-t-il le pack des planches (son lien) ? */
export function creditsMention(root: string, credit: Humans['credit']): boolean {
  return readFileSync(join(root, 'CREDITS.md'), 'utf8').includes(credit.url);
}

export const MODULE = 'virtual:human-atlas';
const RESOLVED = `\0${MODULE}`;

/** Le module de l'atlas, après les contrôles du build. */
export function atlasModule(root: string): string {
  const humans = loadHumans(root);
  const atlas = buildHumanAtlas(root, humans);
  const problems = uncoveredUnderwear(atlas, loadOutfits(root));
  if (!creditsMention(root, humans.credit)) {
    problems.push(`CREDITS.md ne cite pas le pack des planches : ${humans.credit.url} (ADR 0008)`);
  }
  if (problems.length > 0) throw new Error(`atlas des humains :\n${problems.join('\n')}`);
  return `export default ${JSON.stringify(atlas)};`;
}

/**
 * Extension de Vite : le module virtuel de l'atlas des humains, refait quand une planche, une
 * grille de régions, data/humans.json, data/appearance.json ou CREDITS.md change ; en
 * développement, la page se recharge alors.
 */
export function humanAtlas(root: string): Plugin {
  const watched = (path: string) =>
    path.includes('/assets/humans/') ||
    path.includes('/sprites/humans/') ||
    path.endsWith('/data/humans.json') ||
    path.endsWith('/data/appearance.json') ||
    path.endsWith('/CREDITS.md');
  return {
    name: 'pixelciv-human-atlas',
    resolveId(id) {
      return id === MODULE ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const humans = loadHumans(root);
      for (const file of ['data/humans.json', 'data/appearance.json', 'CREDITS.md']) {
        this.addWatchFile(join(root, file));
      }
      for (const sheet of Object.values(humans.sheets)) this.addWatchFile(join(root, sheet));
      for (const sex of ['female', 'male']) {
        for (const animation of humans.animations) {
          this.addWatchFile(join(root, 'assets/humans/regions', sex, `${animation.id}.txt`));
        }
      }
      return atlasModule(root);
    },
    hotUpdate({ file }) {
      if (this.environment.name !== 'client' || !watched(normalizePath(file))) return;
      const graph = this.environment.moduleGraph;
      const module = graph.getModuleById(RESOLVED);
      if (module !== undefined) graph.invalidateModule(module);
      this.environment.hot.send({ type: 'full-reload' });
      return [];
    },
  };
}
