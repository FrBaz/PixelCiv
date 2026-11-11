import { describe, expect, it } from 'vitest';
import {
  cellAt,
  constrain,
  displayScale,
  pan,
  screenToMap,
  TILE_PX,
  visibleChunks,
  zoomAt,
  type Camera,
} from './camera';

const viewport = { width: 1000, height: 600 };
const world = { width: 2048, height: 1024 };
const grid = { columns: 8, rows: 4 };

describe('displayScale', () => {
  it('est continue sous 1 et entière au-delà', () => {
    expect(displayScale(0.37)).toBe(0.37);
    expect(displayScale(1.4)).toBe(1);
    expect(displayScale(2.6)).toBe(3);
  });
});

describe('constrain', () => {
  it("boucle en x et garde les pôles aux bords de l'écran", () => {
    const camera = constrain({ x: -10, y: -500, zoom: 2 }, viewport, world);
    expect(camera.x).toBe(2038);
    expect(camera.y).toBe(150);
    expect(constrain({ x: 4100, y: 5000, zoom: 2 }, viewport, world)).toEqual({
      x: 4,
      y: 874,
      zoom: 2,
    });
  });

  it('centre le monde quand il tient en entier dans la hauteur', () => {
    expect(constrain({ x: 0, y: 0, zoom: 0.25 }, viewport, world).y).toBe(512);
  });
});

describe('gestes', () => {
  it('font suivre le doigt à la carte', () => {
    expect(pan({ x: 100, y: 100, zoom: 2 }, 40, -20)).toEqual({ x: 80, y: 110, zoom: 2 });
  });

  it('gardent fixe le point zoomé', () => {
    const camera: Camera = { x: 500, y: 300, zoom: 1 };
    const before = screenToMap(camera, viewport, 800, 100);
    const zoomed = zoomAt(camera, 3, viewport, 800, 100);
    expect(zoomed.zoom).toBe(3);
    const after = screenToMap(zoomed, viewport, 800, 100);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
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

  it('répète le monde quand on dézoome', () => {
    const placements = visibleChunks(
      { x: 0, y: 512, zoom: 0.25 },
      { width: 2000, height: 600 },
      grid,
      256,
    );
    const columns = placements.filter((placement) => placement.row === 0).map((p) => p.column);
    expect(columns.length).toBeGreaterThan(grid.columns);
  });

  it('ne dessine aucun bloc au-delà des pôles', () => {
    const placements = visibleChunks({ x: 0, y: 0, zoom: 1 }, viewport, grid, 256);
    expect(Math.min(...placements.map((placement) => placement.row))).toBe(0);
    expect(Math.max(...placements.map((placement) => placement.row))).toBeLessThanOrEqual(1);
  });
});
