import { Container, GlProgram, type Application, type Mesh, type Shader } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGameData } from '../core/data';
import type { WorldInfo } from '../core/protocol';
import { emptyLayers, WORLD_SIZES } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import { CHUNK_PX } from './bake';
import type { BakedListener } from './baker';
import { MapView } from './map';
import { MAP_FRAGMENT, MAP_FRAGMENT_WAVES } from './mapShader';
import { wavePhase } from './waves';

// La vue de la carte et la mer animée (ADR 0015), sans GPU ni worker : le répartiteur de la
// cuisson est simulé, et les programmes ne sont pas compilés.
const baker = vi.hoisted(() => ({
  listener: undefined as BakedListener | undefined,
  setWorld: 0,
  patch: 0,
  seaTones: [] as readonly number[],
}));

vi.mock('./baker', () => ({
  Baker: class {
    remaining = 0;
    constructor(listener: BakedListener) {
      baker.listener = listener;
    }
    setWorld(...args: unknown[]) {
      baker.setWorld++;
      baker.seaTones = args[4] as readonly number[];
    }
    patch() {
      baker.patch++;
    }
    prioritize() {
      // Rien : les blocs « cuits » arrivent par baker.listener.
    }
  },
}));

const data = loadGameData();
const size = WORLD_SIZES.small;

beforeEach(() => {
  vi.spyOn(GlProgram, 'from').mockImplementation(
    (options) => ({ fragment: options.fragment, vertex: options.vertex }) as unknown as GlProgram,
  );
  Object.assign(baker, { listener: undefined, setWorld: 0, patch: 0, seaTones: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Une vue de la carte d'un monde Petit, sur un écran de `width` × `height` pixels. */
function mapView(width = 1280, height = 720) {
  const stage = new Container();
  const render = vi.fn();
  const app = {
    renderer: { resolution: 1, render },
    screen: { width, height },
    stage,
  } as unknown as Application;
  const map = new MapView(app, data.biomes.entries);
  const info: WorldInfo = {
    params: defaultWorldParams(data.worldgen.parameters, 'essai', 'small'),
    size,
  };
  map.setWorld(info, emptyLayers(size), () => new Uint8Array(size.width * size.height * 4));
  // Chaque bloc arrive cuit ; seuls ceux de la première colonne ont de la mer.
  const grid = { columns: size.width / 64, rows: size.height / 64 };
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      baker.listener?.(column, row, new Uint8Array(CHUNK_PX * CHUNK_PX * 4), column === 0);
    }
  }
  const layer = stage.children.at(0) as Container;
  /** Programmes des maillages visibles, par colonne de bloc à l'écran (gauche à droite). */
  const programs = () =>
    (layer.children as Mesh[])
      .filter((mesh) => mesh.visible)
      .map((mesh) => {
        const shader = mesh.shader as Shader;
        return {
          fragment: shader.glProgram.fragment,
          origin: shader.resources.origin as { uniforms: { uOrigin: Float32Array } },
          waves: shader.resources.waves as
            { uniforms: { uWavePhase: Float32Array; uWorldPx: number } } | undefined,
        };
      });
  return { map, render, programs };
}

describe('mer animée sur la carte (ADR 0015)', () => {
  it('ne donne le programme de l’onde qu’aux blocs de mer, de près et en mode naturel', () => {
    const { map, programs } = mapView();
    // Le bloc (0, 1) au centre de l'écran, et ses voisins, dont la dernière colonne.
    const camera = { x: 128, y: 384, zoom: 2 };
    map.setWaves(10, 1);
    map.draw(camera);
    const shown = programs();
    expect(shown.length).toBeGreaterThan(2);
    for (const mesh of shown) {
      const sea = mesh.origin.uniforms.uOrigin[0] === 0;
      expect(mesh.fragment).toBe(sea ? MAP_FRAGMENT_WAVES : MAP_FRAGMENT);
    }
    expect(shown.some((mesh) => mesh.fragment === MAP_FRAGMENT)).toBe(true);
    expect(map.wavesShown).toBe(true);
    // Force nulle, autre mode, vue lointaine : le programme de la carte seul.
    const plain = () => programs().every((mesh) => mesh.fragment === MAP_FRAGMENT);
    map.setWaves(11, 0);
    map.draw(camera);
    expect(plain() && !map.wavesShown).toBe(true);
    map.setWaves(11, 1);
    map.setMode('relief');
    map.draw(camera);
    expect(plain() && !map.wavesShown).toBe(true);
    map.setMode('natural');
    map.draw({ ...camera, zoom: 0.5 });
    expect(plain() && !map.wavesShown).toBe(true);
    map.draw(camera);
    expect(plain()).toBe(false);
    // Hors de la mer, rien non plus.
    map.setWaves(12, 1);
    map.draw({ x: 1024, y: 384, zoom: 2 });
    expect(programs().every((mesh) => mesh.fragment === MAP_FRAGMENT)).toBe(true);
    expect(map.wavesShown).toBe(false);
  });

  it('donne aussi le programme de l’onde aux copies d’un bloc de mer', () => {
    // Un écran plus large que le monde : les blocs paraissent deux fois.
    const { map, programs } = mapView(5000, 720);
    map.setWaves(3, 1);
    map.draw({ x: 1024, y: 512, zoom: 1 });
    const shown = programs();
    const sea = shown.filter((mesh) => mesh.origin.uniforms.uOrigin[0] === 0);
    expect(sea.length).toBeGreaterThanOrEqual(2 * (size.height / 64));
    expect(sea.every((mesh) => mesh.fragment === MAP_FRAGMENT_WAVES)).toBe(true);
    expect(shown.filter((mesh) => mesh.fragment === MAP_FRAGMENT_WAVES).length).toBe(sea.length);
  });

  it('avance l’onde par ses uniformes, sans rien recuire', () => {
    const { map, render } = mapView();
    expect(baker.setWorld).toBe(1);
    // Les tons cuits de la mer animée vont au worker, qui les cherche dans chaque bloc.
    expect(baker.seaTones).toHaveLength(9);
    // Le programme de l'onde est compilé hors de l'écran, au premier monde.
    expect(render).toHaveBeenCalledTimes(1);
    const camera = { x: 128, y: 384, zoom: 4 };
    for (let step = 0; step < 40; step++) {
      map.setWaves(step * 997, step % 5 === 0 ? 0 : 1 / (1 + (step % 3)));
      map.setMode(step % 7 === 0 ? 'biomes' : 'natural');
      map.draw({ ...camera, zoom: step % 4 === 0 ? 0.75 : 4 });
    }
    expect(baker.patch).toBe(0);
    expect(baker.setWorld).toBe(1);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('réduit le pas en sa phase, d’après la largeur du monde', () => {
    const { map, programs } = mapView();
    map.setWaves(2 ** 40 + 13_369, 1);
    map.draw({ x: 128, y: 384, zoom: 2 });
    const mesh = (programs().find((entry) => entry.fragment === MAP_FRAGMENT_WAVES) ?? {}) as {
      waves?: { uniforms: { uWavePhase: Float32Array; uWorldPx: number } };
    };
    expect(Array.from(mesh.waves?.uniforms.uWavePhase ?? [])).toEqual([
      ...wavePhase(2 ** 40 + 13_369, size.width * 4),
    ]);
    expect(mesh.waves?.uniforms.uWorldPx).toBe(size.width * 4);
  });
});
