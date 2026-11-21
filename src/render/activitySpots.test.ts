import { describe, expect, it } from 'vitest';
import { FIXED } from '../core/position';
import { DAYS_PER_MONTH } from '../core/time';
import { CHUNK_SIZE, riverClass } from '../core/world';
import { shoreAlong, shoresOf, standsClear } from '../sim/activities';
import { SHORE_STRIDE } from '../sim/activityCache';
import { advanceDay, step } from '../sim/day';
import { INTENTION, REST } from '../sim/population';
import type { SimState } from '../sim/state';
import { scatteredGroups, testData, testState } from '../sim/testing';
import { bakeBiomes, bakeChunk, CHUNK_PX, pixelData, type BakeWorld } from './bake';
import { TILE_PX } from './camera';

/**
 * Les lieux des activités et la carte (tâche 2b.8, critique de la conception, requis 5) : personne ne
 * se tient sur un pixel d'eau de la carte cuite, ni sur un ruisseau qu'elle dessine de près. La rive
 * d'une rivière qui traverse une case de terre est sur une case voisine, hors du lit du pinceau.
 */
describe('lieux des activités sur la carte cuite (ADR 0021, § 3)', () => {
  const activities = testData.activities.activities;
  const waters = activities
    .map((activity, rank) => (activity.place === 'water' ? rank : -1))
    .filter((rank) => rank >= 0);

  /** Pixels de la carte cuite, bloc par bloc, à la demande. */
  function bakedMap(state: SimState) {
    const world: BakeWorld = {
      size: state.size,
      layers: state.world,
      biomes: bakeBiomes(testData.biomes.entries),
      riverBiome: testData.biomes.indexOf('river') ?? -1,
    };
    const chunks = new Map<number, Uint8Array>();
    const columns = state.size.width / CHUNK_SIZE;
    return (x: number, y: number) => {
      const px = Math.floor((x / FIXED) * TILE_PX);
      const py = Math.floor((y / FIXED) * TILE_PX);
      const column = Math.floor(px / CHUNK_PX);
      const row = Math.floor(py / CHUNK_PX);
      const key = row * columns + column;
      let pixels = chunks.get(key);
      if (pixels === undefined) {
        pixels = bakeChunk(world, column, row);
        chunks.set(key, pixels);
      }
      return pixelData(pixels, (py % CHUNK_PX) * CHUNK_PX + (px % CHUNK_PX));
    };
  }

  it('tire chaque rive sur la terre que dessine la carte, à ses deux bouts', () => {
    const state = testState();
    const pixelAt = bakedMap(state);
    const { width, height } = state.size;
    const { spread } = testData.activities.rules.shore;
    let checked = 0;
    // Des camps près de chaque rivière des cases de terre, une case sur cinq.
    for (let cell = 0; cell < width * height; cell += 5) {
      if (riverClass(state.world.drainage[cell] ?? 0) === 0) continue;
      if (!((state.cost[cell] ?? Infinity) < Infinity)) continue;
      const cx = cell % width;
      const cy = Math.floor(cell / width);
      for (const rank of waters) {
        const shores = shoresOf(state, testData, cx, cy, rank);
        for (let at = 0; at < shores.length; at += SHORE_STRIDE) {
          const axis = shores[at + 2] ?? 0;
          // Les deux bouts du tirage le long de la rive, et son milieu.
          for (const fraction of [0, 0.5, 1 - Number.EPSILON / 2]) {
            const along = shoreAlong(fraction, spread);
            const x = (shores[at] ?? 0) + (axis === 1 ? along : 0);
            const y = (shores[at + 1] ?? 0) + (axis === 0 ? along : 0);
            const pixel = pixelAt((x + width * FIXED) % (width * FIXED), y);
            expect(pixel.land, `rive (${String(x / FIXED)}, ${String(y / FIXED)})`).toBe(true);
            expect(pixel.stream, `rive (${String(x / FIXED)}, ${String(y / FIXED)})`).toBe(false);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('ne tient pour libre qu’un point que la carte dessine en terre, hors des ruisseaux', () => {
    const state = testState();
    const pixelAt = bakedMap(state);
    const { width, height } = state.size;
    const { drainage } = state.world;
    const land = (cell: number) => (state.cost[cell] ?? Infinity) < Infinity;
    const wet = (cell: number) => !land(cell) || riverClass(drainage[cell] ?? 0) > 0;
    let allowed = 0;
    let refused = 0;
    // Chaque case de terre voisine d'une eau ou d'une rivière, de côté ou de coin : le centre de
    // chacun de ses pixels, un par quart de case.
    for (let cy = 1; cy < height - 1; cy++) {
      for (let cx = 0; cx < width; cx++) {
        const cell = cy * width + cx;
        if (!land(cell)) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1 && !near; dx++) {
            near = wet((cy + dy) * width + ((cx + dx + width) % width));
          }
        }
        if (!near) continue;
        for (let j = 0; j < TILE_PX; j++) {
          for (let i = 0; i < TILE_PX; i++) {
            const x = cx * FIXED + Math.floor(((i + 0.5) * FIXED) / TILE_PX);
            const y = cy * FIXED + Math.floor(((j + 0.5) * FIXED) / TILE_PX);
            if (!standsClear(state, testData, x, y)) {
              refused++;
              continue;
            }
            const pixel = pixelAt(x, y);
            expect(pixel.land, `point (${String(x / FIXED)}, ${String(y / FIXED)})`).toBe(true);
            expect(pixel.stream, `point (${String(x / FIXED)}, ${String(y / FIXED)})`).toBe(false);
            allowed++;
          }
        }
      }
    }
    expect(allowed).toBeGreaterThan(50_000);
    expect(refused).toBeGreaterThan(10_000);
  });

  it('ne laisse personne, au repos loin de sa place, sur l’eau ou un ruisseau de la carte', () => {
    const state = testState();
    step(state, scatteredGroups(state, 100), testData);
    const pixelAt = bakedMap(state);
    let checked = 0;
    for (let day = 0; day < 2 * DAYS_PER_MONTH; day++) {
      advanceDay(state, [], testData);
      const { people } = state;
      const { x, y, homeX, homeY, move } = people.columns;
      people.forEach((slot) => {
        if (((move[slot] ?? 0) & INTENTION) !== REST) return;
        if (x[slot] === homeX[slot] && y[slot] === homeY[slot]) return;
        const pixel = pixelAt(x[slot] ?? 0, y[slot] ?? 0);
        expect(pixel.land, `emplacement ${String(slot)} au jour ${String(day)}`).toBe(true);
        expect(pixel.stream, `emplacement ${String(slot)} au jour ${String(day)}`).toBe(false);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(5000);
  });
});
