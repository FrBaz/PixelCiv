/**
 * Portraits de face (tâche 2.8 ; REN-07, AST-03 ; ADR 0011).
 *
 * Un portrait de 64 × 64 pixels, tiré de l'individu : la forme du visage et du nez de ses
 * gènes, son sexe, son âge (proportions de l'enfant, rides, calvitie), et une variante
 * tirée de son génome (coiffure, barbe). Le générateur ne dessine que des rôles de teinte
 * (core/visual.ts) : l'interface les recolore selon le teint, la couleur des yeux et des
 * cheveux (grisonnants avec l'âge) et l'habit, comme les mini-sprites (REN-09).
 *
 * Tout ce qui est contenu vient des données (D-6, A-10) : les formes du visage et du nez
 * sont celles des allèles exprimés (data/genetics.json), et les âges de la barbe, de la
 * calvitie et des rides, ainsi que la maturité, ceux de l'espèce (data/species.json).
 *
 * Fonction pure : les mêmes gènes, le même sexe et le même âge donnent le même portrait.
 */
import type { FaceShape, NoseShape, Species } from '../core/data';
import { isMinor } from '../core/life';
import { ROLE, type AgeClass } from '../core/visual';

export const PORTRAIT_SIZE = 64;

export interface PortraitInput {
  readonly sex: number;
  /** Âge en années révolues. */
  readonly age: number;
  /**
   * Classe d'âge, celle de la simulation (core/life.ts) : un nourrisson ou un enfant a les
   * traits de l'enfance, et ni barbe, ni calvitie, ni rides.
   */
  readonly stage: AgeClass;
  /** Maturité et âges de l'apparence de son espèce (data/species.json). */
  readonly species: Pick<Species, 'maturity' | 'ages'>;
  /** Formes du visage et du nez de ses allèles exprimés (data/genetics.json). */
  readonly face: FaceShape;
  readonly nose: NoseShape;
  /** Bits tirés du génome : coiffure, barbe, calvitie. */
  readonly variant: number;
}

class Canvas {
  readonly roles = new Uint8Array(PORTRAIT_SIZE * PORTRAIT_SIZE);

  set(x: number, y: number, role: number): void {
    const column = Math.round(x);
    const row = Math.round(y);
    if (column < 0 || row < 0 || column >= PORTRAIT_SIZE || row >= PORTRAIT_SIZE) return;
    this.roles[row * PORTRAIT_SIZE + column] = role;
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= PORTRAIT_SIZE || y >= PORTRAIT_SIZE) return ROLE.transparent;
    return this.roles[y * PORTRAIT_SIZE + x] ?? ROLE.transparent;
  }

  /**
   * Creuse un pli de la peau (ride, patte d'oie) : la peau, claire ou non, passe à l'ombre,
   * et la peau déjà dans l'ombre au contour, pour que le pli se voie des deux côtés du
   * visage. Ce qui n'est pas de la peau (cheveux, sourcils) ne change pas.
   */
  crease(x: number, y: number): void {
    const role = this.get(x, y);
    if (role === ROLE.skin || role === ROLE.skinLight) this.set(x, y, ROLE.skinShadow);
    else if (role === ROLE.skinShadow) this.set(x, y, ROLE.outline);
  }
}

/** Le point (dx, dy), relatif au centre, est-il dans la tête ? */
function inHead(shape: FaceShape, dx: number, dy: number, grow = 0): boolean {
  // La mâchoire se resserre vers le menton.
  const narrowing = dy > 0 ? 1 - shape.jaw * (dy / shape.height) : 1;
  const u = Math.abs(dx) / ((shape.width + grow) * narrowing);
  const v = Math.abs(dy) / (shape.height + grow);
  const uu = u * u;
  const vv = v * v;
  return shape.power === 2 ? uu + vv <= 1 : uu * uu + vv * vv <= 1;
}

/** Image de rôles d'un portrait, ligne par ligne. */
export function portraitRoles(input: PortraitInput): Uint8Array {
  const canvas = new Canvas();
  const base = input.face;
  const { maturity, ages } = input.species;
  const child = isMinor(input.stage);
  // L'enfant a une tête plus petite et plus basse, des traits plus ronds ; elle grandit
  // jusqu'à la maturité.
  const growth = child ? 0.78 + Math.min(0.22, (0.22 * Math.max(0, input.age)) / maturity) : 1;
  // La tête à dessiner : la forme du visage, à la taille de l'âge.
  const shape: FaceShape = {
    width: Math.round(base.width * growth),
    height: Math.round(base.height * growth),
    power: base.power,
    jaw: child ? base.jaw / 2 : base.jaw,
  };
  const cx = 32;
  const cy = child ? 30 : 26;
  const female = input.sex === 0;
  const variant = input.variant >>> 0;
  const long = female ? (variant & 3) !== 0 : (variant & 7) === 0;
  const beard = !female && !child && input.age >= ages.beard && (variant & 8) !== 0;
  const bald = !female && !child && input.age >= ages.bald && (variant & 48) !== 0;

  // Cheveux longs, derrière la tête et sur les épaules.
  if (long) {
    for (let y = cy - shape.height - 2; y <= Math.min(52, cy + shape.height + 10); y++) {
      for (let x = cx - shape.width - 5; x <= cx + shape.width + 5; x++) {
        const dy = y - cy;
        if (
          inHead(shape, x - cx, Math.min(dy, 0), 4) ||
          (dy >= 0 && Math.abs(x - cx) <= shape.width + 4)
        ) {
          canvas.set(x, y, x > cx + shape.width ? ROLE.hairShadow : ROLE.hair);
        }
      }
    }
  }

  // Épaules et habit, avec une encolure.
  const shoulders = cy + shape.height + 6;
  for (let y = shoulders; y < PORTRAIT_SIZE; y++) {
    const half = Math.min(31, 12 + (y - shoulders) * 1.3);
    for (let x = cx - half; x <= cx + half; x++) {
      const dx = x - cx;
      const collar = Math.abs(dx) <= 4 - (y - shoulders) && y < shoulders + 4;
      const role = collar
        ? ROLE.skin
        : dx > half * 0.55
          ? ROLE.clothShadow
          : dx < -half * 0.6
            ? ROLE.clothLight
            : ROLE.cloth;
      canvas.set(x, y, role);
    }
  }

  // Cou.
  for (let y = cy + shape.height - 4; y < shoulders + 1; y++) {
    for (let x = cx - 4; x <= cx + 4; x++) {
      const shadow = y < cy + shape.height + 1 || x >= cx + 3;
      canvas.set(x, y, shadow ? ROLE.skinShadow : ROLE.skin);
    }
  }

  // Oreilles, puis la tête : la lumière vient d'en haut à gauche.
  for (let dy = -2; dy <= 3; dy++) {
    canvas.set(cx - shape.width - 1, cy + dy, ROLE.skin);
    canvas.set(cx + shape.width + 1, cy + dy, ROLE.skinShadow);
  }
  for (let y = cy - shape.height; y <= cy + shape.height; y++) {
    for (let x = cx - shape.width; x <= cx + shape.width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (!inHead(shape, dx, dy)) continue;
      const role =
        dx > shape.width * 0.5
          ? ROLE.skinShadow
          : dx < -shape.width * 0.55 && dy < 0
            ? ROLE.skinLight
            : ROLE.skin;
      canvas.set(x, y, role);
    }
  }

  // Cheveux du dessus de la tête ; la calvitie dégarnit le sommet.
  const hairline = cy - shape.height * (child ? 0.35 : 0.45) - (variant & 64 ? 1 : 0);
  for (let y = cy - shape.height - 3; y <= hairline + 1; y++) {
    for (let x = cx - shape.width - 2; x <= cx + shape.width + 2; x++) {
      const dx = x - cx;
      if (!inHead(shape, dx, y - cy, 2)) continue;
      if (bald && Math.abs(dx) < shape.width * 0.65 && y > cy - shape.height - 3) continue;
      const edge = y > hairline - 1 && (variant & 128) !== 0 && (x & 1) === 0;
      if (edge) continue;
      canvas.set(
        x,
        y,
        dx > shape.width * 0.5
          ? ROLE.hairShadow
          : dx < -shape.width * 0.4
            ? ROLE.hairLight
            : ROLE.hair,
      );
    }
  }
  // Mèches sur les tempes.
  for (let y = Math.round(hairline); y <= cy - 2; y++) {
    canvas.set(cx - shape.width, y, ROLE.hair);
    canvas.set(cx + shape.width, y, ROLE.hairShadow);
  }

  // Yeux, sourcils : plus grands chez l'enfant.
  const eyeY = cy - (child ? 0 : 1);
  for (const side of [-1, 1]) {
    const ex = cx + side * 6;
    for (let x = ex - 2; x <= ex + 1; x++) {
      canvas.set(x, eyeY, ROLE.white);
      canvas.set(x, eyeY + 1, ROLE.white);
      if (child) canvas.set(x, eyeY + 2, ROLE.white);
      canvas.set(x, eyeY - 1, ROLE.outline);
    }
    canvas.set(ex - 1, eyeY, ROLE.eye);
    canvas.set(ex, eyeY, ROLE.eye);
    canvas.set(ex - 1, eyeY + 1, ROLE.eye);
    canvas.set(ex, eyeY + 1, ROLE.eye);
    for (let x = ex - 3; x <= ex + 2; x++) canvas.set(x, eyeY - 3, ROLE.hairShadow);
    // Pattes d'oie et cernes avec l'âge, du côté de l'ombre aussi.
    if (!child && input.age >= ages.wrinkles.eyes) {
      canvas.crease(ex + side * 3, eyeY - 1);
      canvas.crease(ex + side * 3, eyeY + 1);
    }
  }

  // Nez, selon la forme de son allèle : l'arête, sa bosse, les narines et leur base.
  const { nose } = input;
  const noseTop = eyeY + 2;
  const noseY = cy + (child ? 4 : 5);
  const ridge = Math.max(noseTop, noseY - nose.length);
  for (let y = ridge; y <= noseY; y++) {
    canvas.set(cx + 1, y, ROLE.skinShadow);
    if (nose.hump && y === Math.round((ridge + noseY) / 2)) canvas.set(cx + 2, y, ROLE.skinShadow);
  }
  canvas.set(cx - nose.wing + 1, noseY + 1, ROLE.skinShadow);
  canvas.set(cx + nose.wing, noseY + 1, ROLE.skinShadow);
  if (nose.base) canvas.set(cx, noseY + 1, ROLE.skinShadow);

  // Bouche.
  const mouthY = cy + (child ? 8 : 9);
  const mouth = child ? 2 : 3;
  for (let x = cx - mouth; x <= cx + mouth; x++) canvas.set(x, mouthY, ROLE.mouth);
  if (female)
    for (let x = cx - mouth + 1; x <= cx + mouth - 1; x++) canvas.set(x, mouthY + 1, ROLE.mouth);
  canvas.set(cx, mouthY + 2, ROLE.skinShadow);

  // Barbe et moustache.
  if (beard) {
    for (let y = noseY + 2; y <= cy + shape.height + 1; y++) {
      for (let x = cx - shape.width; x <= cx + shape.width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (!inHead(shape, dx, dy, 1)) continue;
        const mustache = y === mouthY - 1 && Math.abs(dx) <= mouth + 1;
        const jaw = dy > shape.height * 0.3 && (y > mouthY + 1 || Math.abs(dx) > mouth + 1);
        if (mustache || jaw) canvas.set(x, y, dx > shape.width * 0.4 ? ROLE.hairShadow : ROLE.hair);
      }
    }
  }

  // Rides du front, avec l'âge, dans la bande que découvrent les cheveux, entre leur
  // dernière rangée et les sourcils : une ride pointillée dès `wrinkles.forehead` ans (40
  // chez les humains), qui se creuse d'un trait continu à `wrinkles.deep` (60). Elle passe
  // à deux rangées des sourcils si le front y est nu, et une seconde paraît alors, le front
  // creusé, deux rangées plus haut, là où le front l'est encore ; sinon, elle passe juste
  // au-dessus des sourcils, entre eux seulement.
  if (!child && input.age >= ages.wrinkles.forehead) {
    const brow = eyeY - 3;
    const bare = (y: number) =>
      canvas.get(cx - 1, y) === ROLE.skin && canvas.get(cx, y) === ROLE.skin;
    const deep = input.age >= ages.wrinkles.deep;
    const step = deep ? 1 : 2;
    if (bare(brow - 2)) {
      for (let x = cx - 5; x <= cx + 5; x += step) canvas.crease(x, brow - 2);
      if (deep && bare(brow - 4)) {
        for (let x = cx - 4; x <= cx + 4; x += 2) canvas.crease(x, brow - 4);
      }
    } else {
      for (let x = cx - 3; x <= cx + 2; x += step) canvas.crease(x, brow - 1);
    }
  }
  // Sillons autour de la bouche, que la barbe cache.
  if (!child && input.age >= ages.wrinkles.mouth && !beard) {
    for (let step = 0; step <= 3; step++) {
      canvas.set(cx - 4 - step / 2, noseY + 1 + step, ROLE.skinShadow);
      canvas.set(cx + 5 + step / 2, noseY + 1 + step, ROLE.skinShadow);
    }
  }

  // Contour de la silhouette : chaque pixel peint au bord du vide.
  const painted = Uint8Array.from(canvas.roles);
  for (let y = 0; y < PORTRAIT_SIZE; y++) {
    for (let x = 0; x < PORTRAIT_SIZE; x++) {
      const role = painted[y * PORTRAIT_SIZE + x] ?? ROLE.transparent;
      if (role === ROLE.transparent) continue;
      const empty = (nx: number, ny: number) =>
        nx < 0 ||
        ny < 0 ||
        nx >= PORTRAIT_SIZE ||
        (ny < PORTRAIT_SIZE && painted[ny * PORTRAIT_SIZE + nx] === ROLE.transparent);
      if (empty(x - 1, y) || empty(x + 1, y) || empty(x, y - 1) || empty(x, y + 1)) {
        canvas.set(x, y, ROLE.outline);
      }
    }
  }
  return canvas.roles;
}
