import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRegionGrids, RECOLOR, roleParts, type RoleImage } from '../src/gen/humans';
import { loadHumans, sheetFrames } from './human-atlas';

// Justesse des grilles de régions (assets/humans/regions/, ADR 0016, § 2). Deux sortes de
// gardes, chacune avec ses écarts justifiés image par image, dont chacun doit encore servir :
// - les aires : d'une image à l'autre, un membre garde à peu près son aire du repos (entre la
//   moitié et le double, à un pixel près). Elles attrapent un membre entier compté ailleurs (le
//   bras qui longe le torse compté dans le torse, tout le bras levé compté comme avant-bras),
//   pas une bande de quelques pixels ;
// - la topologie, qui voit ce que l'aire ne voit pas : une région ne touche que des régions
//   voisines dans le corps (pas de ventre dans la main, pas de pied sur la cuisse) ; le torse ne
//   se coupe qu'au passage d'un membre ; une main tient à un seul avant-bras, un pied à une seule
//   jambe ; et là où une image recopie le repos, pixel et voisins compris, elle en garde les
//   régions.

const root = fileURLToPath(new URL('..', import.meta.url));
const humans = loadHumans(root);
const letters = humans.regions.map((region) => region.letter).join('');
const sexes = ['female', 'male'] as const;
type Sex = (typeof sexes)[number];
const LIMBS = ['scalp', 'upper-arm', 'forearm', 'hand', 'thigh', 'shin', 'foot'] as const;
const SLACK = 1;

const CROSSED = 'jambes croisées : la cuisse lointaine passe derrière la proche';
const OUTSTRETCHED = 'bras tendus, écartés ou levés : l’avant-bras se voit de tout son long';
const LYING_ARMS = 'couché sur ses bras, qui ne se voient plus';
const LYING_LEGS = 'couché, les jambes vues en raccourci';
const TRAIL = 'la traînée de la chute, au-dessus de la tête qui tombe, porte les cheveux';

type Excuses = Record<string, { readonly frames: readonly number[]; readonly why: string }>;

/** Écarts justifiés des aires : « sexe animation membre » → images, et la raison. */
const EXCEPTIONS: Excuses = {
  'female walk thigh': { frames: [3], why: CROSSED },
  'female run thigh': { frames: [3, 4], why: CROSSED },
  'male run thigh': { frames: [2], why: CROSSED },
  'female run upper-arm': {
    frames: [1],
    why: 'le bras proche, lancé en arrière, ne montre que le haut du bras',
  },
  'female run forearm': {
    frames: [1, 7],
    why: 'le bras lancé devant le corps montre tout son avant-bras',
  },
  'female jump forearm': { frames: [0, 1, 2, 3], why: OUTSTRETCHED },
  'female fall forearm': { frames: [0, 1, 2, 3], why: OUTSTRETCHED },
  'male fall forearm': { frames: [0, 1, 2, 3], why: OUTSTRETCHED },
  'female throw forearm': { frames: [1, 2, 3, 4], why: OUTSTRETCHED },
  'female death scalp': { frames: [7], why: TRAIL },
  'male death scalp': { frames: [7], why: TRAIL },
  'female death upper-arm': { frames: [7, 8, 9], why: LYING_ARMS },
  'female death forearm': { frames: [7, 8, 9], why: LYING_ARMS },
  'female death hand': { frames: [7, 8, 9], why: LYING_ARMS },
  'male death upper-arm': { frames: [7, 8, 9], why: LYING_ARMS },
  'male death forearm': { frames: [7, 8, 9], why: LYING_ARMS },
  'male death hand': { frames: [7, 8, 9], why: LYING_ARMS },
  'female death thigh': { frames: [7], why: 'la traînée de la chute recouvre les cuisses' },
  'female death shin': { frames: [7, 8, 9], why: LYING_LEGS },
  'female death foot': { frames: [7, 8, 9], why: LYING_LEGS },
  'male death shin': { frames: [7, 8, 9], why: LYING_LEGS },
  'male death foot': { frames: [7], why: LYING_LEGS },
};

function areas(sex: Sex, animation: string): Record<string, number>[] {
  const { frames } = parseRegionGrids(
    animation,
    readFileSync(`${root}/assets/humans/regions/${sex}/${animation}.txt`, 'utf8'),
    humans.cell.width,
    humans.cell.height,
    letters,
  );
  return frames.map((grid) => {
    const count: Record<string, number> = {};
    for (const region of humans.regions) {
      count[region.id] = grid.reduce((sum, line) => sum + line.split(region.letter).length - 1, 0);
    }
    return count;
  });
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

interface Finding {
  readonly key: string;
  readonly frame: number;
  readonly what: string;
}

/** Confronte des écarts relevés à leur table : ceux qu'elle n'excuse pas, et ceux qu'elle excuse en vain. */
function judged(found: readonly Finding[], table: Excuses): { outside: string[]; stale: string[] } {
  const used = new Set<string>();
  const outside: string[] = [];
  for (const { key, frame, what } of found) {
    if (Object.hasOwn(table, key) && table[key].frames.includes(frame)) {
      used.add(`${key} ${String(frame)}`);
    } else {
      outside.push(`${key} ${String(frame)} : ${what}`);
    }
  }
  const stale = Object.entries(table)
    .flatMap(([key, { frames }]) => frames.map((frame) => `${key} ${String(frame)}`))
    .filter((entry) => !used.has(entry));
  return { outside, stale };
}

describe('grilles de régions (ADR 0016, § 2)', () => {
  it('gardent à chaque membre son aire du repos, à chaque image de chaque animation, hors écarts justifiés', () => {
    const found: Finding[] = [];
    for (const sex of sexes) {
      const idle = areas(sex, 'idle');
      for (const animation of humans.animations) {
        const frames = areas(sex, animation.id);
        for (const limb of LIMBS) {
          const reference = median(idle.map((count) => count[limb] ?? 0));
          frames.forEach((count, frame) => {
            const area = count[limb] ?? 0;
            if (area >= reference / 2 - SLACK && area <= 2 * reference + SLACK) return;
            found.push({
              key: `${sex} ${animation.id} ${limb}`,
              frame,
              what: `${String(area)} (repos ${String(reference)})`,
            });
          });
        }
      }
    }
    const { outside, stale } = judged(found, EXCEPTIONS);
    expect(outside).toEqual([]);
    // Chaque écart déclaré sert encore : une grille corrigée ne garde pas d'excuse périmée.
    expect(stale).toEqual([]);
  });

  it('donnent au crâne, aux bras et aux jambes une place à chaque image debout', () => {
    for (const sex of sexes) {
      for (const animation of ['idle', 'walk', 'run', 'jump', 'fall', 'throw']) {
        areas(sex, animation).forEach((count, frame) => {
          for (const limb of ['scalp', 'face', 'hips', 'thigh', 'shin', 'foot']) {
            expect(count[limb], `${sex} ${animation} ${String(frame)} ${limb}`).toBeGreaterThan(0);
          }
          expect(count['upper-arm'] + count.forearm + count.hand).toBeGreaterThan(0);
        });
      }
    }
  });
});

// --- Topologie -----------------------------------------------------------------------------------

/**
 * Les jointures du corps : deux régions qui se touchent sans contour entre elles. Le torse
 * (épaules, poitrine, ventre, bassin) se touche en tout sens ; les membres, de proche en proche,
 * du torse à leur bout.
 */
const JOINTS: readonly (readonly [string, string])[] = [
  ['scalp', 'face'],
  ['scalp', 'neck'],
  ['face', 'neck'],
  ['neck', 'shoulders'],
  ['neck', 'chest'],
  ['shoulders', 'chest'],
  ['shoulders', 'belly'],
  ['shoulders', 'hips'],
  ['chest', 'belly'],
  ['chest', 'hips'],
  ['belly', 'hips'],
  ['shoulders', 'upper-arm'],
  ['chest', 'upper-arm'],
  ['upper-arm', 'forearm'],
  ['forearm', 'hand'],
  ['hips', 'thigh'],
  ['thigh', 'shin'],
  ['shin', 'foot'],
];
const TORSO = ['shoulders', 'chest', 'belly', 'hips'];
/** Ce qui rattache au corps un morceau du torse coupé par un membre qui passe devant. */
const TORSO_LINKS = ['neck', 'upper-arm', 'thigh'];
/** Bouts des membres : chacun tient à un seul morceau du segment qui le porte. */
const ENDS: readonly (readonly [string, string])[] = [
  ['forearm', 'hand'],
  ['shin', 'foot'],
];

const FAR_HAND = 'main lointaine : le contour l’isole, son avant-bras est caché derrière le corps';
const BACK_FOOT =
  'pied arrière levé derrière la jambe d’appui : sa jambe est cachée, ou ne le touche qu’en diagonale';
const SHARDS = 'la traînée de la chute laisse des éclats du torse';

/** Écarts justifiés de la topologie : « sexe animation contrôle » → images, et la raison. */
const TOPOLOGY: Excuses = {
  'female idle hand': { frames: [0, 1, 2, 3, 4], why: FAR_HAND },
  'female walk hand': { frames: [3], why: FAR_HAND },
  'female run hand': { frames: [3, 5], why: FAR_HAND },
  'female throw hand': { frames: [0, 5], why: FAR_HAND },
  'female death hand': { frames: [0, 2, 3, 4, 5], why: FAR_HAND },
  'male walk hand': { frames: [3, 5], why: FAR_HAND },
  'male run hand': { frames: [3, 5, 6], why: FAR_HAND },
  'male death hand': { frames: [5, 6], why: FAR_HAND },
  'female run island hand': {
    frames: [5],
    why: 'poing lointain contre la hanche, sans contour entre eux, son avant-bras caché',
  },
  'female walk foot': { frames: [3, 6], why: BACK_FOOT },
  'female run foot': { frames: [3, 6], why: BACK_FOOT },
  'female run torso': {
    frames: [0],
    why: 'un éclat du dos, entre le coude de l’avant-bras qui passe devant et le contour',
  },
  'female death torso': { frames: [7], why: SHARDS },
  'male death torso': { frames: [7], why: SHARDS },
};

/** Une case de la planche : la région de chaque pixel (−1 sans), et son ton sans la région. */
interface Cell {
  readonly width: number;
  readonly height: number;
  readonly region: Int16Array;
  /** 0 transparent, un rôle gardé, ou RECOLOR + 4 × source + rang. */
  readonly tone: Int16Array;
}

function cellOf(image: RoleImage): Cell {
  const region = new Int16Array(image.roles.length).fill(-1);
  const tone = new Int16Array(image.roles.length);
  image.roles.forEach((role, index) => {
    if (role < RECOLOR) {
      tone[index] = role;
      return;
    }
    const parts = roleParts(role);
    region[index] = parts.region;
    tone[index] = RECOLOR + parts.source * 4 + parts.rank;
  });
  return { width: image.width, height: image.height, region, tone };
}

const cells = Object.fromEntries(
  sexes.map((sex) => [sex, sheetFrames(root, humans, sex).map((frames) => frames.map(cellOf))]),
) as Record<Sex, Cell[][]>;
const regionIds = humans.regions.map((region) => region.id);
const regionOf = (id: string) => {
  const index = regionIds.indexOf(id);
  if (index < 0) throw new Error(`région inconnue : ${id}`);
  return index;
};
const joined = new Set(JOINTS.flatMap(([a, b]) => [`${a} ${b}`, `${b} ${a}`]));

type Steps = readonly (readonly [number, number])[];
const SIDES: Steps = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const AROUND: Steps = [...SIDES, [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Les morceaux d'un tenant des pixels retenus : le numéro du morceau de chaque pixel, et leurs pixels. */
function piecesOf(
  cell: Cell,
  inside: (index: number) => boolean,
  steps: Steps = SIDES,
): { label: Int32Array; members: number[][] } {
  const { width, height } = cell;
  const label = new Int32Array(width * height).fill(-1);
  const members: number[][] = [];
  for (let start = 0; start < width * height; start++) {
    if (label[start] !== -1 || !inside(start)) continue;
    const id = members.length;
    const list = [start];
    label[start] = id;
    // La liste s'allonge pendant le parcours : for…of en voit les ajouts.
    for (const index of list) {
      const x = index % width;
      const y = (index - x) / width;
      for (const [dx, dy] of steps) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (label[next] === -1 && inside(next)) {
          label[next] = id;
          list.push(next);
        }
      }
    }
    members.push(list);
  }
  return { label, members };
}

/** Les pixels qui touchent un morceau sans en être. */
function around(cell: Cell, piece: readonly number[], steps: Steps = SIDES): number[] {
  const inside = new Set(piece);
  const out = new Set<number>();
  for (const index of piece) {
    const x = index % cell.width;
    const y = (index - x) / cell.width;
    for (const [dx, dy] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cell.width || ny >= cell.height) continue;
      const next = ny * cell.width + nx;
      if (!inside.has(next)) out.add(next);
    }
  }
  return [...out];
}

/** Chaque image de chaque animation des deux planches. */
function eachFrame(visit: (sex: Sex, animation: string, frame: number, cell: Cell) => void) {
  for (const sex of sexes) {
    humans.animations.forEach((animation, a) => {
      (cells[sex][a] ?? []).forEach((cell, frame) => {
        visit(sex, animation.id, frame, cell);
      });
    });
  }
}

/** (a) Îlots : un morceau d'une région qui ne touche que des régions qui ne la touchent pas dans le corps. */
function islands(): Finding[] {
  const found: Finding[] = [];
  eachFrame((sex, animation, frame, cell) => {
    regionIds.forEach((id, region) => {
      for (const piece of piecesOf(cell, (i) => cell.region[i] === region).members) {
        const touched = new Set(
          around(cell, piece)
            .map((i) => cell.region[i] ?? -1)
            .filter((other) => other >= 0)
            .map((other) => regionIds[other] ?? ''),
        );
        if (touched.size === 0 || [...touched].some((other) => joined.has(`${id} ${other}`))) {
          continue;
        }
        found.push({
          key: `${sex} ${animation} island ${id}`,
          frame,
          what: `${String(piece.length)} pixels de ${id} au contact de ${[...touched].join(', ')}`,
        });
      }
    });
  });
  return found;
}

/** (b) Torse : un morceau hors du torse principal, que ne rattache ni le cou, ni un bras, ni une cuisse. */
function torsoPieces(): Finding[] {
  const torso = new Set(TORSO.map(regionOf));
  const links = new Set(TORSO_LINKS.map(regionOf));
  const found: Finding[] = [];
  eachFrame((sex, animation, frame, cell) => {
    const pieces = piecesOf(cell, (i) => torso.has(cell.region[i] ?? -1)).members.sort(
      (a, b) => b.length - a.length,
    );
    for (const piece of pieces.slice(1)) {
      if (around(cell, piece).some((i) => links.has(cell.region[i] ?? -1))) continue;
      found.push({
        key: `${sex} ${animation} torso`,
        frame,
        what: `${String(piece.length)} pixels du torse isolés`,
      });
    }
  });
  return found;
}

/**
 * (c) Bouts des membres : chaque main touche un seul morceau d'avant-bras, chaque pied un seul
 * morceau de jambe, et un avant-bras ne porte qu'une main, une jambe qu'un pied. Une main ou un
 * pied se compte d'un seul tenant même par la diagonale (un poing dessiné en escalier), et touche
 * en diagonale ; un avant-bras ou une jambe se compte par ses côtés seulement, si bien qu'un pied
 * posé au milieu d'une jambe la coupe en deux morceaux, qu'il touche tous deux.
 */
function limbEnds(): Finding[] {
  const found: Finding[] = [];
  eachFrame((sex, animation, frame, cell) => {
    for (const [segmentId, endId] of ENDS) {
      const segment = regionOf(segmentId);
      const end = regionOf(endId);
      const segments = piecesOf(cell, (i) => cell.region[i] === segment);
      const ends = piecesOf(cell, (i) => cell.region[i] === end, AROUND);
      const report = (what: string) => {
        found.push({ key: `${sex} ${animation} ${endId}`, frame, what });
      };
      for (const piece of ends.members) {
        const held = new Set(
          around(cell, piece, AROUND)
            .map((i) => segments.label[i] ?? -1)
            .filter((id) => id >= 0),
        );
        if (held.size !== 1) {
          report(
            `${String(piece.length)} pixels de ${endId} sur ${String(held.size)} ${segmentId}`,
          );
        }
      }
      for (const piece of segments.members) {
        const borne = new Set(
          around(cell, piece, AROUND)
            .map((i) => ends.label[i] ?? -1)
            .filter((id) => id >= 0),
        );
        if (borne.size > 1) report(`un ${segmentId} porte ${String(borne.size)} ${endId}`);
      }
    }
  });
  return found;
}

/** Fenêtre du recalage sur le repos, en pixels de la case : la mort tombe loin vers l'ouest. */
const SHIFT_X = 32;
const SHIFT_Y = 16;

/**
 * (d) Le repos recopié : chaque image se recale sur l'image 0 du repos du même sexe (le décalage
 * qui y superpose le plus de pixels opaques de même ton) ; un pixel dont le ton et ceux de ses
 * huit voisins sont ceux du repos à cette place en est une recopie, et en porte la région.
 */
function copiesOfIdle(): Finding[] {
  const idle = humans.animations.findIndex((animation) => animation.id === 'idle');
  const found: Finding[] = [];
  for (const sex of sexes) {
    const reference = cells[sex].at(idle)?.at(0);
    if (reference === undefined) throw new Error(`${sex} : aucun repos`);
    const { width, height } = reference;
    const toneAt = (cell: Cell, x: number, y: number) =>
      x < 0 || y < 0 || x >= width || y >= height ? 0 : (cell.tone[y * width + x] ?? 0);
    const opaque: number[] = [];
    reference.tone.forEach((tone, index) => {
      if (tone !== 0) opaque.push(index);
    });
    humans.animations.forEach((animation, a) => {
      (cells[sex][a] ?? []).forEach((cell, frame) => {
        if (a === idle && frame === 0) return;
        let best = { count: -1, dx: 0, dy: 0 };
        for (let dy = -SHIFT_Y; dy <= SHIFT_Y; dy++) {
          for (let dx = -SHIFT_X; dx <= SHIFT_X; dx++) {
            let count = 0;
            for (const index of opaque) {
              const x = index % width;
              const y = (index - x) / width;
              if (toneAt(cell, x + dx, y + dy) === reference.tone[index]) count++;
            }
            if (count > best.count) best = { count, dx, dy };
          }
        }
        const { dx, dy } = best;
        const differs: string[] = [];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const region = cell.region[y * width + x] ?? -1;
            if (region < 0) continue;
            let copy = true;
            for (let oy = -1; oy <= 1 && copy; oy++) {
              for (let ox = -1; ox <= 1 && copy; ox++) {
                copy = toneAt(cell, x + ox, y + oy) === toneAt(reference, x - dx + ox, y - dy + oy);
              }
            }
            const kept = reference.region[(y - dy) * width + x - dx] ?? -1;
            if (copy && kept !== region) {
              differs.push(
                `(${String(x)}, ${String(y)}) ${regionIds[region] ?? ''} au lieu de ${regionIds[kept] ?? ''}`,
              );
            }
          }
        }
        if (differs.length > 0) {
          found.push({ key: `${sex} ${animation.id} idle`, frame, what: differs.join(' ; ') });
        }
      });
    });
  }
  return found;
}

/**
 * (e) La tête du repos reprise : là où une image montre la silhouette de la tête du repos (du
 * haut du crâne à la dernière rangée de la tête, recalée), même si ses tons changent, comme les
 * yeux clos de la mort, chaque pixel qui porte une région dans les deux garde celle du repos : la
 * ligne des cheveux ne bouge pas d'une image à l'autre. Rend aussi les images reconnues.
 */
function headsOfIdle(): { found: Finding[]; matched: string[] } {
  const idle = humans.animations.findIndex((animation) => animation.id === 'idle');
  const head = new Set(
    humans.regions.flatMap((region, index) => (region.head === true ? [index] : [])),
  );
  const found: Finding[] = [];
  const matched: string[] = [];
  for (const sex of sexes) {
    const reference = cells[sex].at(idle)?.at(0);
    if (reference === undefined) throw new Error(`${sex} : aucun repos`);
    const { width, height } = reference;
    let top = height;
    let bottom = -1;
    reference.tone.forEach((tone, index) => {
      const y = Math.floor(index / width);
      if (tone !== 0) top = Math.min(top, y);
      if (head.has(reference.region[index] ?? -1)) bottom = Math.max(bottom, y);
    });
    let left = width;
    let right = -1;
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < width; x++) {
        if ((reference.tone[y * width + x] ?? 0) === 0) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    const toneAt = (cell: Cell, x: number, y: number) =>
      x < 0 || y < 0 || x >= width || y >= height ? 0 : (cell.tone[y * width + x] ?? 0);
    // Un ton gardé : contour, œil, trait (le reste est de la peau ou du sous-vêtement).
    const drawn = (tone: number) => tone !== 0 && tone < RECOLOR;
    const face = regionOf('face');
    // La même silhouette, bord compris (une rangée au-dessus et une colonne de chaque côté), et
    // des traits sur ceux du repos ou sur son visage : des yeux clos s'y dessinent autrement, des
    // sourcils montés dans le front (la tête levée du saut) en font une autre tête.
    const same = (cell: Cell, dx: number, dy: number) => {
      for (let y = top - 1; y <= bottom; y++) {
        for (let x = left - 1; x <= right + 1; x++) {
          const tone = toneAt(cell, x + dx, y + dy);
          const kept = toneAt(reference, x, y);
          if ((tone !== 0) !== (kept !== 0)) return false;
          const onFace = kept !== 0 && reference.region[y * width + x] === face;
          if (drawn(tone) && !drawn(kept) && !onFace) return false;
        }
      }
      return true;
    };
    humans.animations.forEach((animation, a) => {
      (cells[sex][a] ?? []).forEach((cell, frame) => {
        if (a === idle && frame === 0) return;
        let shift: readonly [number, number] | undefined;
        for (let dy = -SHIFT_Y; dy <= SHIFT_Y && shift === undefined; dy++) {
          for (let dx = -SHIFT_X; dx <= SHIFT_X && shift === undefined; dx++) {
            if (same(cell, dx, dy)) shift = [dx, dy];
          }
        }
        if (shift === undefined) return;
        const [dx, dy] = shift;
        matched.push(`${sex} ${animation.id} ${String(frame)}`);
        const differs: string[] = [];
        for (let y = top; y <= bottom; y++) {
          for (let x = left; x <= right; x++) {
            const kept = reference.region[y * width + x] ?? -1;
            const region = cell.region[(y + dy) * width + x + dx] ?? -1;
            if (kept >= 0 && region >= 0 && kept !== region) {
              differs.push(
                `(${String(x + dx)}, ${String(y + dy)}) ${regionIds[region] ?? ''} au lieu de ${regionIds[kept] ?? ''}`,
              );
            }
          }
        }
        if (differs.length > 0) {
          found.push({ key: `${sex} ${animation.id} head`, frame, what: differs.join(' ; ') });
        }
      });
    });
  }
  return { found, matched };
}

describe('topologie des grilles de régions (ADR 0016, § 2)', () => {
  it('nomment chaque région des données dans les jointures du corps, et rien d’autre', () => {
    const named = new Set([...JOINTS.flat(), ...TORSO, ...TORSO_LINKS, ...ENDS.flat()]);
    expect(regionIds.filter((id) => !named.has(id))).toEqual([]);
    expect([...named].filter((id) => !regionIds.includes(id))).toEqual([]);
  });

  it('ne posent aucune région au seul contact de régions qui ne la touchent pas dans le corps, hors écarts justifiés', () => {
    expect(judged(islands(), TOPOLOGY).outside).toEqual([]);
  });

  it('ne détachent du torse que des morceaux que rattache le cou, un bras ou une cuisse, hors écarts justifiés', () => {
    expect(judged(torsoPieces(), TOPOLOGY).outside).toEqual([]);
  });

  it('tiennent chaque main à un seul avant-bras et chaque pied à une seule jambe, hors écarts justifiés', () => {
    expect(judged(limbEnds(), TOPOLOGY).outside).toEqual([]);
  });

  it('ne gardent aucun écart de topologie qui ne sert plus', () => {
    expect(judged([...islands(), ...torsoPieces(), ...limbEnds()], TOPOLOGY).stale).toEqual([]);
  });

  it('gardent les régions du repos là où une image le recopie, pixel et voisins compris', () => {
    const found = copiesOfIdle().map(({ key, frame, what }) => `${key} ${String(frame)} : ${what}`);
    expect(found).toEqual([]);
  });

  it('gardent la ligne des cheveux du repos là où une image en reprend la tête, yeux clos compris', () => {
    const { found, matched } = headsOfIdle();
    expect(found.map(({ key, frame, what }) => `${key} ${String(frame)} : ${what}`)).toEqual([]);
    // Les têtes de la mort aux yeux clos, que la recopie des tons ne voit pas, en sont.
    for (const sex of sexes) {
      for (let frame = 0; frame <= 6; frame++) {
        expect(matched).toContain(`${sex} death ${String(frame)}`);
      }
    }
  });
});
