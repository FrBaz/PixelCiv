/**
 * Grilles de rôles des objets du calque commun (tâche 2b.6 ; AST-04 ; ADR 0017, § 3, 4 et 7) :
 * la lecture d'une grille de texte selon la légende de son atlas, l'ombre portée d'un motif, et
 * le rangement des motifs dans un atlas de rôles. Le décor s'en sert (tools/decor-atlas.ts) ;
 * le gibier s'en servira, avec sa propre légende et sans ombre.
 *
 * Une grille (assets/decor/README.md) : un caractère par pixel, des lignes de même longueur ;
 * en tête, « # légende <nom> », le nom de la légende de son atlas, et « # pieds N », la colonne
 * des pieds, qui se posent sur la dernière rangée. Les autres lignes qui commencent par « # »,
 * et les lignes vides, sont des commentaires. Les erreurs nomment la grille et la ligne, comptée
 * comme dans le fichier.
 */
import { legendRoles, type RoleLegend } from '../src/gen/legend.ts';
import type { RoleImage } from '../src/gen/humans.ts';

/** Largeur des atlas de rôles, celle de l'atlas des humains : ils partagent une texture. */
export const ROLE_ATLAS_WIDTH = 1024;

/** Lit une grille de rôles `name` selon la légende `legend` ; lève une erreur qui nomme la ligne. */
export function parseRoleGrid(name: string, text: string, legend: RoleLegend): RoleImage {
  const roles = legendRoles(legend);
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  let declared: string | undefined;
  let anchorX: number | undefined;
  const rows: string[] = [];
  let lastLine = 0;
  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    const where = `${name}, ligne ${String(index + 1)}`;
    const heading = /^#\s*légende\s+(\S+)\s*$/u.exec(line);
    if (heading !== null) {
      declared = heading[1];
      if (declared !== legend.name) {
        throw new Error(`${where} : légende « ${heading[1]} », l'atlas lit « ${legend.name} »`);
      }
      return;
    }
    const feet = /^#\s*pieds\s+(\d+)\s*$/u.exec(line);
    if (feet !== null) {
      anchorX = Number(feet[1]);
      return;
    }
    if (line === '' || line.startsWith('#')) return;
    if (declared === undefined) {
      throw new Error(`${where} : la légende se déclare en tête (« # légende ${legend.name} »)`);
    }
    const width = rows.at(0)?.length ?? line.length;
    if (line.length !== width) {
      throw new Error(`${where} : ${String(line.length)} pixels, la grille en a ${String(width)}`);
    }
    for (let column = 0; column < line.length; column++) {
      const char = line.charAt(column);
      if (!roles.has(char)) {
        throw new Error(
          `${where}, colonne ${String(column + 1)} : « ${char} » hors de la légende ${legend.name}`,
        );
      }
    }
    rows.push(line);
    lastLine = index + 1;
  });
  if (declared === undefined) {
    throw new Error(`${name} : légende absente (« # légende ${legend.name} »)`);
  }
  const width = rows.at(0)?.length ?? 0;
  const height = rows.length;
  if (height === 0) throw new Error(`${name} : grille vide`);
  if (anchorX === undefined) throw new Error(`${name} : colonne des pieds absente (« # pieds N »)`);
  if (anchorX >= width) {
    throw new Error(`${name} : pieds en colonne ${String(anchorX)}, hors de ${String(width)}`);
  }
  const image = new Uint8Array(width * height);
  rows.forEach((line, y) => {
    for (let x = 0; x < width; x++) image[y * width + x] = roles.get(line.charAt(x)) ?? 0;
  });
  // Les pieds se posent sur la dernière rangée : elle a au moins un pixel.
  if (image.subarray((height - 1) * width).every((role) => role === 0)) {
    throw new Error(`${name}, ligne ${String(lastLine)} : dernière rangée vide, sous les pieds`);
  }
  return { width, height, roles: image, anchorX, anchorY: height };
}

/**
 * L'ombre portée d'un motif, d'une lumière du nord-est (ADR 0017, § 4) : chaque pixel, à h
 * rangées au-dessus de la rangée des pieds, se projette au sol en (u − sx × h, pieds + sy × h),
 * là où le motif n'a pas de pixel. L'ombre prend les rôles `roles` en damier : le premier où la
 * somme des écarts au point des pieds est paire, le second ailleurs (la trame de la méthode
 * « dither »). Le motif s'élargit à gauche et s'allonge sous ses pieds ; son point des pieds suit.
 */
export function withShadow(
  image: RoleImage,
  sx: number,
  sy: number,
  roles: readonly [number, number],
): RoleImage {
  const { width, height, anchorX, anchorY } = image;
  const feetRow = anchorY - 1;
  const points: number[] = [];
  let minX = 0;
  let maxX = width - 1;
  let maxY = height - 1;
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      if (image.roles[v * width + u] === 0) continue;
      const h = feetRow - v;
      if (h < 0) continue;
      const x = Math.round(u - h * sx);
      const y = Math.round(feetRow + h * sy);
      points.push(x, y);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const outWidth = maxX - minX + 1;
  const outHeight = maxY + 1;
  const out = new Uint8Array(outWidth * outHeight);
  for (let index = 0; index < points.length; index += 2) {
    const x = points[index];
    const y = points[index + 1];
    const parity = (((x - anchorX + y - feetRow) % 2) + 2) % 2;
    out[y * outWidth + x - minX] = roles[parity];
  }
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const role = image.roles[v * width + u];
      if (role !== 0) out[v * outWidth + u - minX] = role;
    }
  }
  return { width: outWidth, height: outHeight, roles: out, anchorX: anchorX - minX, anchorY };
}

/**
 * Range des motifs dans un atlas de `width` de large, en ligne d'horizon : chacun, du plus haut
 * au plus bas, à la place où son haut est le plus bas, un pixel vide entre deux motifs. Bien
 * plus serré que des étagères quand les hauteurs varient.
 */
export function packSkyline(
  images: readonly { readonly width: number; readonly height: number }[],
  width = ROLE_ATLAS_WIDTH,
): { height: number; at: { x: number; y: number }[] } {
  const skyline = new Int32Array(width);
  const order = images
    .map((_, index) => index)
    .sort(
      (a, b) =>
        (images[b]?.height ?? 0) - (images[a]?.height ?? 0) ||
        (images[b]?.width ?? 0) - (images[a]?.width ?? 0) ||
        a - b,
    );
  const at = images.map(() => ({ x: 0, y: 0 }));
  let height = 0;
  for (const index of order) {
    const image = images[index];
    const span = Math.min(width, image.width + 1);
    if (image.width > width)
      throw new Error(`motif de ${String(image.width)} pixels, plus large que l'atlas`);
    let bestX = 0;
    let bestY = Number.POSITIVE_INFINITY;
    for (let x = 0; x + image.width <= width; x++) {
      let y = 0;
      for (let dx = 0; dx < span && x + dx < width; dx++) y = Math.max(y, skyline[x + dx] ?? 0);
      if (y < bestY) {
        bestY = y;
        bestX = x;
      }
    }
    at[index] = { x: bestX, y: bestY };
    for (let dx = 0; dx < span && bestX + dx < width; dx++)
      skyline[bestX + dx] = bestY + image.height + 1;
    height = Math.max(height, bestY + image.height);
  }
  return { height, at };
}

/** Pose des motifs rangés dans les rôles d'un atlas de `width` × `height`. */
export function drawAtlas(
  images: readonly RoleImage[],
  at: readonly { x: number; y: number }[],
  width: number,
  height: number,
): Uint8Array {
  const roles = new Uint8Array(width * height);
  images.forEach((image, index) => {
    const { x, y } = at[index] ?? { x: 0, y: 0 };
    for (let row = 0; row < image.height; row++) {
      roles.set(
        image.roles.subarray(row * image.width, (row + 1) * image.width),
        (y + row) * width + x,
      );
    }
  });
  return roles;
}
