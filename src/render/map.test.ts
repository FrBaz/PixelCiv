import {
  Container,
  GlProgram,
  type Application,
  type BufferImageSource,
  type Mesh,
  type Shader,
} from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGameData } from '../core/data';
import type { WorldInfo } from '../core/protocol';
import { seasonFactor } from '../core/seasons';
import { FOLIAGE_BYTES, NO_DATE, worldFoliage } from '../core/foliage';
import { CALENDAR_BYTES } from '../core/snow';
import { emptyLayers, WORLD_SIZES } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import { CHUNK_PX } from './bake';
import type { BakedListener } from './baker';
import { MapView } from './map';
import {
  MAP_FRAGMENT,
  MAP_FRAGMENT_SEASONS,
  MAP_FRAGMENT_WAVES,
  MAP_FRAGMENT_WAVES_SEASONS,
} from './mapShader';
import { EXACT_SCALE } from './seasonShader';
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

/** Des calendriers de la neige et de la glace pour le monde des essais : huit octets par case. */
const noCalendars = () => new Uint8Array(size.width * size.height * 2 * CALENDAR_BYTES);
/** Un calendrier de la végétation sans aucun état : quatre octets par case, tous à 255. */
const noFoliage = () => new Uint8Array(size.width * size.height * FOLIAGE_BYTES).fill(NO_DATE);
/** Une carte d'identité des tons d'un bloc, sans ton reconnu. */
const identity = () => new Uint8Array(CHUNK_PX * CHUNK_PX);

/**
 * Une vue de la carte d'un monde Petit, sur un écran de `width` × `height` pixels, aux couches
 * `layers` et au calendrier de la végétation `foliage`.
 */
function mapView(width = 1280, height = 720, layers = emptyLayers(size), foliage = noFoliage()) {
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
  const map = new MapView(app, data.biomes.entries, data.seasons, data.decor.foliage);
  const info: WorldInfo = {
    params: defaultWorldParams(data.worldgen.parameters, 'essai', 'small'),
    size,
  };
  map.setWorld(
    info,
    layers,
    noCalendars(),
    foliage,
    () => new Uint8Array(size.width * size.height * 4),
  );
  // Chaque bloc arrive cuit ; seuls ceux de la première colonne ont de la mer, partout.
  const grid = { columns: size.width / 64, rows: size.height / 64 };
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const pixels = new Uint8Array(CHUNK_PX * CHUNK_PX * 4);
      baker.listener?.(column, row, pixels, seaMask(column === 0 ? 'all' : []), identity());
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
          resources: shader.resources as Record<string, unknown>,
          origin: shader.resources.origin as { uniforms: { uOrigin: Float32Array } },
          waves: shader.resources.waves as
            { uniforms: { uWavePhase: Float32Array; uWorldPx: number } } | undefined,
        };
      });
  /** Le groupe des réglages de l'onde, que portent les shaders de l'onde. */
  const waveGroup = () => {
    const mesh = (layer.children as Mesh[]).find((child) => child.visible);
    const shader = mesh?.shader as Shader | undefined;
    return (shader?.resources.waves ?? {}) as {
      isStatic?: boolean;
      _dirtyId?: number;
      uniforms?: Record<string, unknown>;
    };
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
    baker.listener?.(
      3,
      1,
      new Uint8Array(CHUNK_PX * CHUNK_PX * 4),
      seaMask([[15, 15]]),
      identity(),
    );
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

  it('compile les programmes de l’onde et des saisons hors de l’écran, une seule fois, au premier monde', () => {
    const { map, render, compiled, info } = mapView();
    expect(render).toHaveBeenCalledTimes(3);
    expect(compiled.map((entry) => entry.fragment)).toEqual([
      MAP_FRAGMENT_WAVES,
      MAP_FRAGMENT_SEASONS,
      MAP_FRAGMENT_WAVES_SEASONS,
    ]);
    expect(compiled.every((entry) => entry.target !== undefined)).toBe(true);
    // Un second monde n'a plus rien à compiler.
    map.setWorld(
      info,
      emptyLayers(size),
      noCalendars(),
      noFoliage(),
      () => new Uint8Array(size.width * size.height * 4),
    );
    expect(render).toHaveBeenCalledTimes(3);
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
    map.setWorld(
      info,
      emptyLayers(size),
      noCalendars(),
      noFoliage(),
      () => new Uint8Array(size.width * size.height * 4),
    );
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

describe('neige et glace à inertie sur la carte (ADR 0019)', () => {
  it('range les calendriers du monde dans une texture de W × 2H texels, et refuse une autre longueur', () => {
    const { map, info, programs } = mapView();
    const calendars = noCalendars();
    calendars[0] = 17;
    calendars[calendars.length - 1] = 42;
    map.setWorld(
      info,
      emptyLayers(size),
      calendars,
      noFoliage(),
      () => new Uint8Array(size.width * size.height * 4),
    );
    for (let row = 0; row < size.height / 64; row++) {
      for (let column = 0; column < size.width / 64; column++) {
        baker.listener?.(
          column,
          row,
          new Uint8Array(CHUNK_PX * CHUNK_PX * 4),
          seaMask(),
          identity(),
        );
      }
    }
    map.draw({ x: 128, y: 384, zoom: 2 });
    const texture = programs().at(0)?.resources.uCalendars as BufferImageSource;
    expect([texture.width, texture.height]).toEqual([size.width, size.height * 2]);
    expect(texture.resource).toBe(calendars);
    expect(map.ground?.calendars).toBe(texture);
    expect(() => {
      map.setWorld(
        info,
        emptyLayers(size),
        new Uint8Array(8),
        noFoliage(),
        () => new Uint8Array(4),
      );
    }).toThrow(RangeError);
  });

  it('reçoit les rampes et le calme de data/seasons.json, et le jour continu de l’année', () => {
    const { map, programs, waveGroup } = mapView();
    map.setSeason(3.25);
    map.setWaves(5, 1);
    map.draw({ x: 128, y: 384, zoom: 2 });
    const globals = programs().at(0)?.resources.globals as {
      uniforms: Record<string, number | Float32Array>;
    };
    const { uniforms } = globals;
    const { snow, freshIce, seaIce } = data.seasons;
    const ramp = (value: number | Float32Array | undefined) => Array.from(value as Float32Array);
    expect(ramp(uniforms.uSnowRamp)).toEqual([snow.ramp.onset, snow.ramp.span, snow.ramp.full]);
    expect(ramp(uniforms.uIceRamp)).toEqual(
      [freshIce.ramp.onset, freshIce.ramp.span, freshIce.ramp.full].map(Math.fround),
    );
    expect(ramp(uniforms.uSeaIceRamp)).toEqual(
      [seaIce.ramp.onset, seaIce.ramp.span, seaIce.ramp.full].map(Math.fround),
    );
    expect(uniforms.uForestSnow).toBe(snow.forest);
    expect(uniforms.uDay).toBe(3.25 * 30);
    expect(uniforms.uSeason).toBe(seasonFactor(3.25));
    expect(waveGroup().uniforms?.uCalmDays).toBe(data.seasons.calmDays);
  });
});

describe('version et signature de la carte (rendu à la demande, ADR 0010)', () => {
  it('lit le jour : deux jours de même facteur de saison, de part et d’autre de l’été, diffèrent', () => {
    // La neige à inertie ne suit pas le seul facteur de saison : la mi-juillet est un sommet, et
    // deux jours symétriques l'ont égal, l'un en se réchauffant, l'autre en se refroidissant.
    const { map } = mapView();
    const camera = { x: 1024, y: 384, zoom: 2 };
    map.setSeason(6.5 - 0.7);
    map.draw(camera);
    const before = map.signature();
    map.setSeason(6.5 + 0.7);
    map.draw(camera);
    expect(seasonFactor(6.5 + 0.7)).toBeCloseTo(seasonFactor(6.5 - 0.7), 12);
    expect(map.signature()).not.toEqual(before);
  });

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
        baker.listener?.(3, 1, new Uint8Array(CHUNK_PX * CHUNK_PX * 4), seaMask(), identity());
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

describe('couleurs de la saison sur la carte (ADR 0019, § 2, 3 et 6 ; ADR 0020)', () => {
  /** Une forêt tempérée sur tout le monde : 8 °C de moyenne, 12 °C de demi-amplitude. */
  const forest = () => {
    const layers = emptyLayers(size);
    layers.biome.fill(data.biomes.indexOf('temperate-forest') ?? 0);
    layers.temperature.fill(80);
    layers.amplitude.fill(120);
    const foliage = worldFoliage(size, layers, {
      foliage: data.decor.foliage,
      seasons: data.seasons,
    });
    return { layers, foliage };
  };
  /** La vue d'un bloc du nord (rangée 0) ou du sud (rangée 3), au zoom 2. */
  const north = { x: 1024 + 128, y: 128, zoom: 2 };
  const south = { x: 1024 + 128, y: 1024 - 128, zoom: 2 };

  it('lit la carte d’identité pixel à pixel tant que le GPU lit des pixels cuits (EXACT_SCALE)', () => {
    // Au plus proche, le GPU lit le niveau 0 des mipmaps au-dessus de 2^(−1/2) : de 0,75 à 1, les
    // couleurs de la saison restent celles des palettes déclarées (relecture de 2b.7, problème 2).
    const { map, programs } = mapView();
    const exact = () => {
      const globals = programs().at(0)?.resources.globals as
        { uniforms: { uExact: number; uFine: number } } | undefined;
      return [globals?.uniforms.uExact, globals?.uniforms.uFine];
    };
    for (const [zoom, expected] of [
      [2, [1, 1]],
      [1, [1, 1]],
      [0.8, [1, 0]],
      [EXACT_SCALE, [1, 0]],
      [0.74, [0, 0]],
      [0.5, [0, 0]],
    ] as const) {
      map.draw({ x: 1024, y: 512, zoom });
      expect(exact(), `zoom ${String(zoom)}`).toEqual(expected);
    }
  });

  it('ne donne les programmes des saisons qu’aux blocs dont une case change à cette date', () => {
    const { layers, foliage } = forest();
    const { map, programs } = mapView(1280, 720, layers, foliage);
    const fragments = () => new Set(programs().map((mesh) => mesh.fragment));
    // Au cœur de l'été du nord, ses blocs gardent le programme de la carte.
    map.setSeason(6.5);
    map.draw(north);
    expect([...fragments()]).toEqual([MAP_FRAGMENT]);
    expect(map.seasonsShown).toBe(false);
    // Mi-octobre au nord : ses forêts roussissent.
    map.setSeason(9.5);
    map.draw(north);
    expect(fragments().has(MAP_FRAGMENT_SEASONS)).toBe(true);
    expect(map.seasonsShown).toBe(true);
    // Le sud vit son été en janvier.
    map.setSeason(0.5);
    map.draw(south);
    expect([...fragments()]).toEqual([MAP_FRAGMENT]);
    map.draw(north);
    expect(fragments().has(MAP_FRAGMENT_SEASONS)).toBe(true);
  });

  it('au cran coupé, ne donne à aucun bloc ni les saisons ni l’onde', () => {
    const { layers, foliage } = forest();
    const { map, programs } = mapView(1280, 720, layers, foliage);
    map.setSeason(9.5);
    map.setWaves(5, 0);
    map.setSeasonColors('off');
    // Tout le monde à l'écran, de la mer à la première colonne : rien que la carte.
    for (const camera of [north, south, { x: 128, y: 384, zoom: 2 }]) {
      map.draw(camera);
      expect(new Set(programs().map((mesh) => mesh.fragment))).toEqual(new Set([MAP_FRAGMENT]));
    }
    expect(map.seasonsShown).toBe(false);
    // Les états seuls, sans la lumière d'hiver : les saisons reviennent, uLight vaut 0.
    map.setSeasonColors('states');
    map.draw(north);
    const seasonal = programs().find((mesh) => mesh.fragment === MAP_FRAGMENT_SEASONS) as
      | { resources: { seasons: { uniforms: { uLight: number; uFoliageDays: number } } } }
      | undefined;
    expect(seasonal?.resources.seasons.uniforms.uLight).toBe(0);
    expect(seasonal?.resources.seasons.uniforms.uFoliageDays).toBe(data.seasons.minTransition);
    map.setSeasonColors('full');
    expect(seasonal?.resources.seasons.uniforms.uLight).toBe(1);
  });

  it('donne à ses programmes la carte d’identité de chaque bloc, le calendrier et les tons des états', () => {
    const { layers, foliage } = forest();
    const { map, programs } = mapView(1280, 720, layers, foliage);
    map.setSeason(9.5);
    map.draw(north);
    const mesh = programs().find((entry) => entry.fragment === MAP_FRAGMENT_SEASONS) as
      { resources: Record<string, BufferImageSource> } | undefined;
    const identity = mesh?.resources.uIdentity;
    expect([identity?.width, identity?.height]).toEqual([CHUNK_PX / 4, CHUNK_PX]);
    const calendar = mesh?.resources.uFoliage;
    expect([calendar?.width, calendar?.height]).toEqual([size.width, size.height]);
    // Le calendrier filtré : une forêt tempérée garde son automne et son bois nu.
    expect(Array.from((calendar?.resource as Uint8Array).subarray(0, 2))).toEqual(
      Array.from(foliage.subarray(0, 2)),
    );
    expect(mesh?.resources.uStates.width).toBe(17);
    // Une carte d'identité qui arrive avec son bloc cuit.
    const tones = new Uint8Array(CHUNK_PX * CHUNK_PX).fill(4);
    baker.listener?.(4, 0, new Uint8Array(CHUNK_PX * CHUNK_PX * 4), seaMask(), tones);
    map.draw(north);
    const chunk = programs().find(
      (entry) =>
        entry.fragment === MAP_FRAGMENT_SEASONS && entry.origin.uniforms.uOrigin[0] === 4 * 64,
    ) as { resources: Record<string, BufferImageSource> } | undefined;
    expect(chunk?.resources.uIdentity.resource).toEqual(tones);
  });

  it('lit dans la signature de l’image ce que montrent les couleurs de la saison', () => {
    const { layers, foliage } = forest();
    const { map } = mapView(1280, 720, layers, foliage);
    map.setSeason(9.5);
    map.draw(north);
    const signatures = (['full', 'states', 'off'] as const).map((colors) => {
      map.setSeasonColors(colors);
      map.draw(north);
      return map.signature().join(',');
    });
    expect(new Set(signatures).size).toBe(3);
  });

  it('refuse un calendrier de la végétation d’une autre longueur', () => {
    const { map, info } = mapView();
    expect(() => {
      map.setWorld(
        info,
        emptyLayers(size),
        noCalendars(),
        new Uint8Array(4),
        () => new Uint8Array(4),
      );
    }).toThrow(RangeError);
  });
});
