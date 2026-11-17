import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, chunkGrid, WORLD_SIZES } from '../core/world';
import {
  cellAt,
  constrain,
  displayScale,
  MAX_ZOOM,
  pan,
  physicalZoom,
  screenToMap,
  showAt,
  TILE_PX,
  visibleChunks,
  zoomAt,
  zoomLimits,
  type Camera,
} from './camera';

const viewport = { width: 1000, height: 600 };
const world = { width: 2048, height: 1024 };
const grid = { columns: 8, rows: 4 };

/** Côté d'un bloc de carte, en pixels de carte. */
const CHUNK_PX = CHUNK_SIZE * TILE_PX;

/** Les mondes prédéfinis, en pixels de carte, avec leur grille de blocs (MON-02). */
const worlds = Object.values(WORLD_SIZES).map((size) => ({
  extent: { width: size.width * TILE_PX, height: size.height * TILE_PX },
  grid: chunkGrid(size),
}));

describe('displayScale', () => {
  it('est continue sous 1 et entière au-delà', () => {
    expect(displayScale(0.37)).toBe(0.37);
    expect(displayScale(1.4)).toBe(1);
    expect(displayScale(2.6)).toBe(3);
  });
});

describe('zoomLimits (2b.1)', () => {
  it("remplit la hauteur de l'écran au zoom le plus faible : continu sous 1, entier au-delà", () => {
    // Un monde Petit fait 1 024 pixels de carte de haut.
    expect(zoomLimits({ width: 1280, height: 720 }, world, 1).min).toBe(720 / 1024);
    expect(zoomLimits({ width: 1024, height: 1024 }, world, 1).min).toBe(1);
    // L'échelle 1,05 mêlerait des pixels de carte d'un et de deux pixels physiques : c'est
    // le palier 2 qui remplit 1 080 pixels.
    expect(zoomLimits({ width: 1920, height: 1080 }, world, 1).min).toBe(2);
    // Pixel 5, de densité 2,75 : 2 340 pixels physiques de haut en portrait, 1 080 en paysage.
    expect(zoomLimits({ width: 1080, height: 2340 }, world, 2.75).min).toBe(3);
    expect(zoomLimits({ width: 2340, height: 1080 }, world, 2.75).min).toBe(2);
  });

  it('ne montre jamais rien au-delà des pôles au zoom le plus faible, compte tenu de displayScale', () => {
    const failures: string[] = [];
    for (const { extent, grid: chunks } of worlds) {
      for (let height = 1; height <= 5000; height++) {
        const screen = { width: 64, height };
        const { min } = zoomLimits(screen, extent, 1);
        // Hauteur de la carte à l'écran, à l'échelle affichée.
        const shown = displayScale(min) * extent.height;
        const fills =
          min < 1
            ? Math.abs(shown - height) < 1e-6
            : Number.isInteger(min) && shown >= height && shown - extent.height < height;
        if (!fills) failures.push(`${String(extent.height)} / ${String(height)} : ${String(min)}`);
        // Les blocs dessinés couvrent toutes les rangées de l'écran, la caméra au pôle nord,
        // au milieu du monde ou au pôle sud.
        if (height % 7 !== 0) continue;
        for (const y of [0, extent.height / 2, extent.height]) {
          const camera = constrain({ x: 0, y, zoom: min }, screen, extent, 1);
          const placements = visibleChunks(camera, screen, chunks, CHUNK_PX);
          const top = Math.min(...placements.map((placement) => placement.top));
          const bottom = Math.max(...placements.map((p) => p.top + p.height));
          if (top > 0 || bottom < height) {
            failures.push(
              `${String(extent.height)} / ${String(height)} / ${String(y)} : ${String(top)}…${String(bottom)}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("suit la taille de l'écran : chaque redimensionnement change le zoom le plus faible", () => {
    const sizes = [
      [1280, 720],
      [1920, 1080],
      [1280, 720],
      [800, 2100],
    ] as const;
    const minima = sizes.map(([width, height]) => zoomLimits({ width, height }, world, 1).min);
    expect(minima).toEqual([720 / 1024, 2, 720 / 1024, 3]);
  });

  it('monte au plus à 24 pixels CSS par pixel de carte : 24 × la densité, au palier entier', () => {
    expect(MAX_ZOOM).toBe(24);
    expect(zoomLimits(viewport, world, 1).max).toBe(24);
    expect(zoomLimits(viewport, world, 2).max).toBe(48);
    expect(zoomLimits(viewport, world, 2.75).max).toBe(66);
    expect(zoomLimits(viewport, world, 2 / 3).max).toBe(16);
    // À la densité 1,1, le palier 27 ferait 24,5 pixels CSS : le zoom s'arrête à 26.
    expect(zoomLimits(viewport, world, 1.1).max).toBe(26);
    const failures: number[] = [];
    for (let step = 100; step <= 800; step++) {
      const resolution = step / 200;
      const { max } = zoomLimits(viewport, world, resolution);
      // Un palier entier, que l'affichage n'arrondit pas, et le dernier sous 24 pixels CSS.
      const last = displayScale(max) === max && max / resolution <= 24 + 1e-9;
      if (!last || (max + 1) / resolution <= 24) failures.push(resolution);
    }
    expect(failures).toEqual([]);
  });

  it('tient sur un écran encore sans hauteur, avant la mise en page', () => {
    const empty = { width: 0, height: 0 };
    expect(zoomLimits(empty, world, 2)).toEqual({ min: 1, max: 48 });
    expect(constrain({ x: 100, y: 300, zoom: 4 }, empty, world, 2)).toEqual({
      x: 100,
      y: 300,
      zoom: 4,
    });
  });
});

describe('physicalZoom', () => {
  it('convertit un zoom en pixels CSS en pixels physiques, au palier entier le plus proche', () => {
    expect(physicalZoom(2, 1)).toBe(2);
    expect(physicalZoom(3, 1)).toBe(3);
    // Pixel 5, de densité 2,75 : 5,5 donne 6, et 8,25 donne 8, soit 2,9 pixels CSS.
    expect(physicalZoom(2, 2.75)).toBe(6);
    expect(physicalZoom(3, 2.75)).toBe(8);
    expect(physicalZoom(3, 1.5)).toBe(5);
    // Sous 1, l'échelle est continue : le zoom 2 reste 2 pixels CSS à la densité 0,4.
    expect(physicalZoom(2, 0.4)).toBeCloseTo(0.8, 12);
  });
});

describe('constrain', () => {
  it("boucle en x et garde les pôles aux bords de l'écran", () => {
    const camera = constrain({ x: -10, y: -500, zoom: 2 }, viewport, world, 1);
    expect(camera.x).toBe(2038);
    expect(camera.y).toBe(150);
    expect(constrain({ x: 4100, y: 5000, zoom: 2 }, viewport, world, 1)).toEqual({
      x: 4,
      y: 874,
      zoom: 2,
    });
  });

  it('ramène le zoom entre ses bornes, et centre le monde qui remplit tout juste la hauteur', () => {
    // 600 pixels de haut pour un monde de 1 024 : au plus faible, l'échelle 0,5859375.
    const camera = constrain({ x: 0, y: 0, zoom: 0.25 }, viewport, world, 1);
    expect(camera.zoom).toBe(600 / 1024);
    expect(camera.y).toBe(512);
    expect(constrain({ x: 0, y: 0, zoom: 100 }, viewport, world, 1).zoom).toBe(24);
    expect(constrain({ x: 0, y: 0, zoom: 100 }, viewport, world, 2).zoom).toBe(48);
  });
});

describe('gestes', () => {
  it('font suivre le doigt à la carte', () => {
    expect(pan({ x: 100, y: 100, zoom: 2 }, 40, -20)).toEqual({ x: 80, y: 110, zoom: 2 });
  });

  it('gardent fixe le point zoomé', () => {
    const camera: Camera = { x: 500, y: 300, zoom: 1 };
    const before = screenToMap(camera, viewport, 800, 100);
    const zoomed = zoomAt(camera, 3, viewport, 800, 100, zoomLimits(viewport, world, 1));
    expect(zoomed.zoom).toBe(3);
    const after = screenToMap(zoomed, viewport, 800, 100);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("s'arrêtent aux bornes du zoom, le point zoomé toujours fixe", () => {
    const camera: Camera = { x: 500, y: 300, zoom: 2 };
    const limits = zoomLimits(viewport, world, 2);
    const before = screenToMap(camera, viewport, 800, 100);
    for (const [factor, zoom] of [
      [100, 48],
      [0.001, 600 / 1024],
    ] as const) {
      const zoomed = zoomAt(camera, factor, viewport, 800, 100, limits);
      expect(zoomed.zoom).toBe(zoom);
      expect(screenToMap(zoomed, viewport, 800, 100).x).toBeCloseTo(before.x, 9);
    }
  });
});

describe('showAt', () => {
  it("montre le point de la carte au point de l'écran demandé, au même zoom (U-5)", () => {
    for (const zoom of [0.5, 1, 3]) {
      const camera: Camera = { x: 100, y: 200, zoom };
      // Au milieu de la partie visible, à gauche de la colonne de droite, et non au centre.
      const shown = showAt(camera, viewport, 1500, 700, 300, 250);
      expect(shown.zoom).toBe(zoom);
      const point = screenToMap(shown, viewport, 300, 250);
      expect(point.x).toBeCloseTo(1500, 9);
      expect(point.y).toBeCloseTo(700, 9);
    }
    // Au centre de l'écran, la caméra vise le point lui-même.
    expect(showAt({ x: 0, y: 0, zoom: 2 }, viewport, 42, 24, 500, 300)).toEqual({
      x: 42,
      y: 24,
      zoom: 2,
    });
  });
});

describe('cellAt', () => {
  it('ramène dans le monde la colonne touchée dans une copie voisine du monde (W-3, U-2)', () => {
    const columns = 512;
    const width = columns * TILE_PX;
    for (let copy = -2; copy <= 2; copy++) {
      // Le milieu de la case (5, 60), puis celui de la dernière colonne, dans chaque copie.
      expect(cellAt(copy * width + 5.5 * TILE_PX, 60.5 * TILE_PX, columns)).toEqual({
        x: 5,
        y: 60,
      });
      expect(cellAt(copy * width - 0.5 * TILE_PX, 60.5 * TILE_PX, columns)).toEqual({
        x: columns - 1,
        y: 60,
      });
    }
    // Au-delà des pôles, la ligne sort du monde : c'est à l'appelant de la refuser.
    expect(cellAt(5.5 * TILE_PX, -0.5 * TILE_PX, columns).y).toBe(-1);
  });
});

describe('visibleChunks', () => {
  it("remplit l'écran sans trou ni recouvrement, couture comprise", () => {
    for (const zoom of [0.3, 0.77, 1, 2, 5]) {
      for (const x of [0, 3, 1023.5, 2047.9]) {
        const placements = visibleChunks({ x, y: 512, zoom }, viewport, grid, 256);
        const row = placements.filter((placement) => placement.row === placements[0]?.row);
        expect(row.at(0)?.left).toBeLessThanOrEqual(0);
        expect((row.at(-1)?.left ?? 0) + (row.at(-1)?.width ?? 0)).toBeGreaterThanOrEqual(
          viewport.width,
        );
        row.slice(1).forEach((current, index) => {
          const previous = row[index];
          expect(current.left).toBe(previous.left + previous.width);
          expect(current.column).toBe((previous.column + 1) % grid.columns);
        });
        expect(placements.every((placement) => Number.isInteger(placement.left))).toBe(true);
      }
    }
  });

  it('affiche le dernier bloc à gauche du premier, à la couture', () => {
    const placements = visibleChunks({ x: 0, y: 512, zoom: 1 }, viewport, grid, 256);
    const columns = placements.filter((placement) => placement.row === 1).map((p) => p.column);
    expect(columns).toEqual([6, 7, 0, 1]);
  });

  it('répète le monde, au zoom le plus faible, sur un écran plus allongé que lui (ADR 0002)', () => {
    const columnsAt = (screen: { width: number; height: number }) => {
      const zoom = zoomLimits(screen, world, 1).min;
      const placements = visibleChunks({ x: 0, y: 512, zoom }, screen, grid, 256);
      return placements.filter((placement) => placement.row === 0).map((p) => p.column);
    };
    // 2 000 × 600 : plus allongé que le monde, de format 2:1, qui se répète.
    expect(columnsAt({ width: 2000, height: 600 }).length).toBeGreaterThan(grid.columns);
    // 1 000 × 600 : chaque bloc paraît une fois au plus.
    const columns = columnsAt(viewport);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it('ne dessine aucun bloc au-delà des pôles', () => {
    const placements = visibleChunks({ x: 0, y: 0, zoom: 1 }, viewport, grid, 256);
    expect(Math.min(...placements.map((placement) => placement.row))).toBe(0);
    expect(Math.max(...placements.map((placement) => placement.row))).toBeLessThanOrEqual(1);
  });
});
