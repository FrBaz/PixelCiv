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
import { SEA_TILE, seaTones, wavePhase, waveTable } from './waves';

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
/** Tuiles du masque de la mer d'un bloc, par côté. */
const TILES = CHUNK_PX / SEA_TILE;
/** Masque de mer d'un bloc : de la mer dans les tuiles (colonne, rangée) données, ou partout. */
const seaMask = (tiles: readonly (readonly [number, number])[] | 'all' = []) => {
  const mask = new Uint8Array(TILES * TILES).fill(tiles === 'all' ? 1 : 0);
  if (tiles !== 'all') for (const [column, row] of tiles) mask[row * TILES + column] = 1;
  return mask;
};

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
  // Ce que chaque rendu hors de l'écran dessine, relevé pendant l'appel : le maillage est
  // détruit aussitôt après.
  const compiled: { fragment: string | undefined; target: unknown }[] = [];
  const render = vi.fn((options: { container: Mesh; target?: unknown }) => {
    const shader = options.container.shader as Shader | null;
    compiled.push({ fragment: shader?.glProgram.fragment, target: options.target });
  });
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
  // Chaque bloc arrive cuit ; seuls ceux de la première colonne ont de la mer, partout.
  const grid = { columns: size.width / 64, rows: size.height / 64 };
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const pixels = new Uint8Array(CHUNK_PX * CHUNK_PX * 4);
      baker.listener?.(column, row, pixels, seaMask(column === 0 ? 'all' : []));
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
  /** Le groupe des réglages de l'onde, que portent les shaders de l'onde. */
  const waveGroup = () => {
    const mesh = (layer.children as Mesh[]).find((child) => child.visible);
    const shader = mesh?.shader as Shader | undefined;
    return (shader?.resources.waves ?? {}) as { isStatic?: boolean; _dirtyId?: number };
  };
  return { map, render, compiled, programs, waveGroup, info };
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

  it('ne donne le programme de l’onde qu’au bloc dont la partie visible touche la mer', () => {
    const { map, programs } = mapView();
    // Le bloc (3, 1) couvre les pixels de carte [768, 1024[ × [256, 512[ ; de la mer dans sa
    // seule tuile du coin sud-est, [1008, 1024[ × [496, 512[.
    baker.listener?.(3, 1, new Uint8Array(CHUNK_PX * CHUNK_PX * 4), seaMask([[15, 15]]));
    const fragmentOf = (column: number, row: number) =>
      programs().find(
        (mesh) =>
          mesh.origin.uniforms.uOrigin[0] === column * 64 &&
          mesh.origin.uniforms.uOrigin[1] === row * 64,
      )?.fragment;
    // Au zoom 2, l'écran de 1 280 × 720 pixels montre [448, 1088[ × [76, 436[ : le bloc y
    // paraît sans sa tuile de mer.
    const north = { x: 768, y: 256, zoom: 2 };
    map.setWaves(20, 1);
    map.draw(north);
    expect(fragmentOf(3, 1)).toBe(MAP_FRAGMENT);
    expect(map.wavesShown).toBe(false);
    const still = map.signature();
    map.setWaves(21, 1);
    map.draw(north);
    expect(map.signature()).toEqual(still);
    // Sa tuile de mer à l'écran, au bord : le programme de l'onde, et le pas dans la signature.
    const south = { x: 768, y: 496 - 180 + 1, zoom: 2 };
    map.draw(south);
    expect(fragmentOf(3, 1)).toBe(MAP_FRAGMENT_WAVES);
    expect(map.wavesShown).toBe(true);
    const moving = map.signature();
    map.setWaves(22, 1);
    map.draw(south);
    expect(map.signature()).not.toEqual(moving);
    // Un pixel plus haut, la tuile quitte l'écran.
    map.draw({ ...south, y: south.y - 1 });
    expect(fragmentOf(3, 1)).toBe(MAP_FRAGMENT);
  });

  it('envoie au worker les tons cuits de la mer animée', () => {
    mapView();
    expect(baker.setWorld).toBe(1);
    // Ceux des trois mers (ADR 0015, point 3), que le worker cherche dans chaque bloc.
    expect(baker.seaTones).toEqual(seaTones(waveTable(data.biomes.entries, 1)));
    expect(baker.seaTones).toHaveLength(9);
  });

  it('compile le programme de l’onde hors de l’écran, une seule fois, au premier monde', () => {
    const { map, render, compiled, info } = mapView();
    expect(render).toHaveBeenCalledTimes(1);
    expect(compiled[0]?.fragment).toBe(MAP_FRAGMENT_WAVES);
    expect(compiled[0]?.target).toBeDefined();
    // Un second monde n'a plus rien à compiler.
    map.setWorld(info, emptyLayers(size), () => new Uint8Array(size.width * size.height * 4));
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('ne recuit rien quand le pas, la force, le mode ou le zoom changent', () => {
    const { map } = mapView();
    const camera = { x: 128, y: 384, zoom: 4 };
    for (let step = 0; step < 40; step++) {
      map.setWaves(step * 997, step % 5 === 0 ? 0 : 1 / (1 + (step % 3)));
      map.setMode(step % 7 === 0 ? 'biomes' : 'natural');
      map.draw({ ...camera, zoom: step % 4 === 0 ? 0.75 : 4 });
    }
    expect(baker.patch).toBe(0);
    expect(baker.setWorld).toBe(1);
  });

  it('ne renvoie au GPU les réglages de l’onde que lorsqu’ils changent', () => {
    const { map, waveGroup, info } = mapView();
    const camera = { x: 128, y: 384, zoom: 2 };
    map.setWaves(5, 1);
    map.draw(camera);
    // Un groupe statique : PixiJS ne le renvoie qu'après update(), une fois pour le programme.
    const group = waveGroup();
    expect(group.isStatic).toBe(true);
    const sent = () => group._dirtyId;
    let last = sent();
    const expectSent = (changed: boolean) => {
      if (changed) expect(sent()).not.toBe(last);
      else expect(sent()).toBe(last);
      last = sent();
    };
    // Les mêmes réglages, image après image : rien à renvoyer.
    for (let frame = 0; frame < 3; frame++) {
      map.setWaves(5, 1);
      map.draw(camera);
      map.draw({ ...camera, x: camera.x + frame });
    }
    expectSent(false);
    // Le pas suivant, une autre force, un autre monde : renvoyés.
    map.setWaves(6, 1);
    expectSent(true);
    map.setWaves(6, 0.5);
    expectSent(true);
    map.setWaves(6, 0.5);
    map.draw(camera);
    expectSent(false);
    map.setWorld(info, emptyLayers(size), () => new Uint8Array(size.width * size.height * 4));
    expectSent(true);
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

describe('version et signature de la carte (rendu à la demande, ADR 0010)', () => {
  it('change de signature avec ce qu’elle dessine, et seulement avec cela', () => {
    const { map } = mapView();
    const camera = { x: 128, y: 384, zoom: 2 };
    map.setSeason(1);
    map.setWaves(5, 1);
    map.draw(camera);
    const first = map.signature();
    // Rien ne change : la même signature.
    map.setSeason(1);
    map.setWaves(5, 1);
    map.draw(camera);
    expect(map.signature()).toEqual(first);
    // Le pas de l'onde y entre quand elle se voit, et seulement alors.
    map.setWaves(6, 1);
    map.draw(camera);
    expect(map.signature()).not.toEqual(first);
    const land = { x: 1024, y: 384, zoom: 2 };
    map.draw(land);
    const still = map.signature();
    map.setWaves(7, 1);
    map.draw(land);
    expect(map.signature()).toEqual(still);
    // La force, la saison, le mode, un bloc cuit, des cases repeintes : une autre signature.
    const changes: (() => void)[] = [
      () => {
        map.setWaves(7, 0.5);
      },
      () => {
        map.setSeason(2);
      },
      () => {
        map.setMode('biomes');
      },
      () => {
        baker.listener?.(3, 1, new Uint8Array(CHUNK_PX * CHUNK_PX * 4), seaMask());
      },
      () => {
        map.updateChunks([{ column: 3, row: 1, biome: new Uint8Array(64 * 64) }]);
      },
    ];
    for (const change of changes) {
      const before = map.signature();
      change();
      map.draw(land);
      expect(map.signature()).not.toEqual(before);
    }
  });
});
