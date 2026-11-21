import { describe, expect, it } from 'vitest';
import { testData, testWorld } from '../sim/testing';
import { loadSettings } from './data/catalog';
import { SeasonsSchema, type Seasons } from './data/schemas';
import { cos, TAU } from './dmath';
import { Fingerprint } from './hash';
import { coverShare, seasonFactor } from './seasons';
import {
  calendarBytes,
  calendarLevel,
  CALENDAR_BYTES,
  cellClimate,
  codeAmplitude,
  codeTemperature,
  COLDEST_PHASE,
  composeCover,
  coverRamps,
  coverSettings,
  encodeAmplitude,
  encodeTemperature,
  iceAt,
  iceCalendar,
  RAMP_ONLY,
  phaseDay,
  RAIN_STEP,
  snowAt,
  snowCalendar,
  warmestDay,
  worldCalendars,
  YEAR_DAYS,
  type CalendarClimate,
  type CalendarCover,
} from './snow';
import { emptyLayers, WORLD_SIZES } from './world';

const SEASONS = testData.seasons;

/** Le climat arrondi d'une case : température annuelle et demi-amplitude (°C), pluie (mm). */
function climate(annual: number, amplitude: number, precipitation: number, rain = 0) {
  return {
    temperature: encodeTemperature(annual),
    amplitude: encodeAmplitude(amplitude),
    precipitation: Math.round(precipitation / RAIN_STEP),
    rain,
  } satisfies CalendarClimate;
}

/** Le calendrier d'une couverture sur ce climat, en octets. */
function bytesOf(at: CalendarClimate, cover: CalendarCover, seasons: Seasons = SEASONS) {
  const packed =
    cover === 'snow' ? snowCalendar(at, seasons) : iceCalendar(at, cover === 'sea-ice', seasons);
  return calendarBytes(packed);
}

/** La part couverte au dixième de jour, sur l'année, et la rampe de 7c893a7 aux mêmes jours. */
function year(at: CalendarClimate, cover: CalendarCover, seasons: Seasons = SEASONS) {
  const ramp = coverRamps(seasons)[cover];
  const bytes = bytesOf(at, cover, seasons);
  const annual = codeTemperature(at.temperature);
  const amplitude = codeAmplitude(at.amplitude);
  const days = Array.from({ length: YEAR_DAYS * 10 }, (_, index) => {
    const phase = index / 10;
    const daily = annual + amplitude * cos((TAU * phase) / YEAR_DAYS);
    return {
      phase,
      share: composeCover(ramp, annual, amplitude, daily, phase, calendarLevel(bytes, 0, phase)),
      ramp: coverShare(ramp, daily),
    };
  });
  return {
    days,
    bytes,
    floor: coverShare(ramp, annual + amplitude),
    most: coverShare(ramp, annual - amplitude),
    /** La plus grande pente de la rampe, par jour. */
    slope: ((amplitude * TAU) / YEAR_DAYS) * (ramp.full / ramp.span),
    /** Premier et dernier jour où la part, ou la rampe, dépasse `level`. */
    first: (level: number, key: 'share' | 'ramp' = 'share') =>
      days.find((day) => day[key] > level)?.phase ?? Number.NaN,
    last: (level: number, key: 'share' | 'ramp' = 'share') =>
      days.findLast((day) => day[key] > level)?.phase ?? Number.NaN,
  };
}

/**
 * Des climats tirés des sondes de la conception et de sa critique, sur les trois graines :
 * - toundra de pixelciv (154, 16) : mois le plus chaud à 0,25 °C, où la rampe couvrait 8 % ;
 * - toundra plus froide : mois le plus chaud entre 0 et 0,5 °C ;
 * - banquise côtière à −9 °C l'été ;
 * - plaine continentale, steppe sèche, côte douce et humide, montagne humide, lac ;
 * - tropiques, sans neige ni glace.
 */
const CLIMATES = {
  tundra: climate(-14, 14.25, 400),
  coldTundra: climate(-14, 14.375, 400),
  alpine: climate(-4, 6, 1200),
  seaIce: climate(-20.5, 11.375, 100),
  plain: climate(5, 15, 600),
  steppe: climate(0, 16, 150),
  maritime: climate(6, 6, 1500),
  lake: climate(2, 14, 700),
  /** Un réservoir lent, qui s'emplit après le jour le plus froid ; un hiver sans pluie. */
  slowSteppe: climate(-2, 10, 60),
  desert: climate(-8, 14, 0),
  tropics: climate(25, 1, 2000, 90),
} as const;

/** Les couvertures de chaque climat de CLIMATES. */
const COVERS: readonly (readonly [keyof typeof CLIMATES, CalendarCover])[] = [
  ['tundra', 'snow'],
  ['coldTundra', 'snow'],
  ['alpine', 'snow'],
  ['plain', 'snow'],
  ['steppe', 'snow'],
  ['slowSteppe', 'snow'],
  ['desert', 'snow'],
  ['maritime', 'snow'],
  ['lake', 'ice'],
  ['plain', 'ice'],
  ['seaIce', 'sea-ice'],
  ['tundra', 'ice'],
];

describe('phase des calendriers', () => {
  it('se compte depuis le jour le plus chaud de la case, tiré du facteur de saison', () => {
    expect(warmestDay(false)).toBe(195);
    expect(warmestDay(true)).toBe(15);
    for (const month of [0.5, 3.2, 6.5, 9.9, 11.7]) {
      const day = month * 30;
      // cos de la phase = facteur de saison au nord, son opposé au sud (core/seasons.ts).
      expect(cos((TAU * phaseDay(day, false)) / YEAR_DAYS)).toBeCloseTo(seasonFactor(month), 12);
      expect(cos((TAU * phaseDay(day, true)) / YEAR_DAYS)).toBeCloseTo(-seasonFactor(month), 12);
    }
    expect(phaseDay(195, false)).toBe(0);
    expect(phaseDay(15, false)).toBe(COLDEST_PHASE);
    expect(phaseDay(359.5, true)).toBeCloseTo(344.5, 12);
  });

  it("du calendrier sans inertie, rend la rampe de l'instant toute l'année", () => {
    const ramp = SEASONS.snow.ramp;
    for (let phase = 1; phase < YEAR_DAYS; phase += 0.5) {
      expect(calendarLevel(RAMP_ONLY, 0, phase)).toBe(phase < COLDEST_PHASE ? 1 : 0);
      const daily = -3 + 9 * cos((TAU * phase) / YEAR_DAYS);
      expect(composeCover(ramp, -3, 9, daily, phase, calendarLevel(RAMP_ONLY, 0, phase))).toBe(
        coverShare(ramp, daily),
      );
    }
  });
});

describe('part couverte à inertie (ADR 0019, § 1)', () => {
  it('ne dépasse jamais la rampe de 7c893a7 au refroidissement, au dixième de jour', () => {
    for (const [name, cover] of COVERS) {
      const { days } = year(CLIMATES[name], cover);
      for (const day of days.filter((entry) => entry.phase < COLDEST_PHASE)) {
        expect(day.share, `${name}, ${cover}, ${String(day.phase)}`).toBeLessThanOrEqual(
          day.ramp + 1e-12,
        );
      }
    }
  });

  it('ne part jamais plus tôt que la rampe au réchauffement, et garde son plancher d’été', () => {
    let floors = 0;
    for (const [name, cover] of COVERS) {
      const { days, floor } = year(CLIMATES[name], cover);
      if (floor > 0) floors++;
      for (const day of days) {
        const label = `${name}, ${cover}, ${String(day.phase)}`;
        expect(day.share, label).toBeGreaterThanOrEqual(floor - 1e-12);
        if (day.phase >= COLDEST_PHASE) {
          expect(day.share, label).toBeGreaterThanOrEqual(day.ramp - 1e-12);
        }
      }
    }
    // La toundra de pixelciv, la plus froide et la banquise : la rampe y couvre encore l'été.
    expect(floors).toBe(3);
  });

  it("ne dépasse pas la rampe au cœur de l'été, et la rend à sa fin : juillet comme 7c893a7", () => {
    const half = SEASONS.summerDays / 2;
    for (const [name, cover] of COVERS) {
      const { days, floor } = year(CLIMATES[name], cover);
      for (const day of days) {
        const label = `${name}, ${cover}, ${String(day.phase)}`;
        // Les 30 jours centrés sur le jour le plus chaud, hors des glaciers (un biome) : jamais
        // plus que la rampe ; la descente est finie, si bien que la fin de l'été est la rampe.
        if (day.phase <= half) expect(day.share, label).toBeLessThanOrEqual(day.ramp + 1e-12);
        if (day.phase >= YEAR_DAYS - half) expect(day.share, label).toBe(day.ramp);
      }
      // Au jour le plus chaud, la part de 7c893a7 : celle de la rampe au mois le plus chaud.
      expect(days[0]?.share, name).toBe(floor);
    }
    // La toundra de pixelciv (154, 16) : 8 % de neige à la mi-juillet, comme en 7c893a7.
    const tundra = year(CLIMATES.tundra, 'snow');
    expect(tundra.floor).toBeCloseTo(1 / 12, 12);
    expect(tundra.days[0]?.share).toBeCloseTo(1 / 12, 12);
  });

  it("n'est permanente que là où la rampe couvre l'été autant que l'hiver", () => {
    // Une neige qui ne fond jamais (−1 °C au mois le plus chaud) : la rampe couvre plus l'hiver.
    const frozen = year(climate(-12, 11, 800), 'snow');
    expect(frozen.most).toBe(1);
    expect(Math.min(...frozen.days.map((day) => day.share))).toBeLessThan(0.6);
    // La rampe pleine toute l'année : aucun calendrier, la part de la rampe.
    const glacial = year(climate(-20, 5, 800), 'snow');
    expect(glacial.floor).toBe(1);
    expect(glacial.bytes).toEqual(RAMP_ONLY);
    expect(glacial.days.every((day) => day.share === 1)).toBe(true);
    for (const [name, cover] of COVERS) {
      const { days, floor, most } = year(CLIMATES[name], cover);
      if (most <= 0) continue;
      expect(Math.min(...days.map((day) => day.share)), name).toBeCloseTo(floor, 12);
      expect(floor, name).toBeLessThan(most);
    }
  });

  it("n'enneige pas l'été là où son mois le plus chaud dépasse le seuil de la rampe", () => {
    for (const name of ['plain', 'steppe', 'maritime', 'alpine'] as const) {
      const { days, floor } = year(CLIMATES[name], 'snow');
      expect(floor, name).toBe(0);
      const july = days.filter((day) => day.phase <= 15 || day.phase >= 345);
      expect(
        july.every((day) => day.share === 0),
        name,
      ).toBe(true);
    }
  });

  it('arrive plus tard que la rampe, et plus tard encore là où il neige peu', () => {
    const wet = year(climate(0, 16, 1200), 'snow');
    const dry = year(climate(0, 16, 150), 'snow');
    const level = 0.5;
    const ramp = wet.first(level, 'ramp');
    expect(dry.first(level, 'ramp')).toBe(ramp);
    expect(wet.first(level)).toBeGreaterThanOrEqual(ramp);
    expect(dry.first(level)).toBeGreaterThan(wet.first(level) + 5);
  });

  it('reste après le redoux, au plus maxLag jours après la rampe, plus longtemps épaisse', () => {
    const seaIce = climate(-10, 10, 100);
    for (const [at, cover, lag] of [
      [CLIMATES.plain, 'snow', SEASONS.snow.maxLag],
      [CLIMATES.alpine, 'snow', SEASONS.snow.maxLag],
      [CLIMATES.steppe, 'snow', SEASONS.snow.maxLag],
      [CLIMATES.lake, 'ice', SEASONS.freshIce.maxLag],
      [seaIce, 'sea-ice', SEASONS.seaIce.maxLag],
    ] as const) {
      const shares = year(at, cover);
      const ramp = shares.last(0, 'ramp');
      const end = shares.last(0);
      const label = `${cover}, ${String(at.temperature)}`;
      expect(end, label).toBeLessThanOrEqual(ramp + lag + 0.1);
      expect(end, label).toBeGreaterThan(ramp + 10);
    }
    // Sur une grille de climats, au dixième de jour près.
    for (let annual = -12; annual <= 6; annual += 1.5) {
      for (const amplitude of [4, 7.5, 11, 14.5, 18]) {
        for (const precipitation of [80, 400, 1500]) {
          for (const cover of ['snow', 'ice', 'sea-ice'] as const) {
            const shares = year(climate(annual, amplitude, precipitation), cover);
            if (shares.most <= shares.floor) continue;
            const lag = coverSettings(SEASONS, cover).maxLag;
            const ramp = shares.last(shares.floor, 'ramp');
            const end = Math.min(ramp + lag, YEAR_DAYS - SEASONS.summerDays / 2);
            expect(shares.last(shares.floor + 1e-12)).toBeLessThanOrEqual(
              Math.max(ramp, end) + 0.1,
            );
          }
        }
      }
    }
    // Une neige épaisse reste plus longtemps qu'une neige mince, au même froid.
    const thick = year(climate(4, 14, 1600), 'snow');
    const thin = year(climate(4, 14, 300), 'snow');
    expect(thick.last(0.5)).toBeGreaterThan(thin.last(0.5) + 5);
  });

  it("couvre au cœur de l'hiver autant que la rampe, même là où il neige peu", () => {
    for (const [name, cover] of COVERS) {
      const { days, most } = year(CLIMATES[name], cover);
      expect(days[COLDEST_PHASE * 10]?.share, name).toBe(most);
    }
    // Un hiver sans pluie : le réservoir ne paraît jamais, la neige vient au cœur de l'hiver.
    const desert = year(CLIMATES.desert, 'snow');
    expect(desert.days[COLDEST_PHASE * 10]?.share).toBe(1);
    expect(desert.first(0)).toBeGreaterThanOrEqual(COLDEST_PHASE - SEASONS.minTransition - 1.5);
    expect(desert.last(0)).toBe(desert.last(0, 'ramp'));
  });

  it('ne saute jamais : la part change au plus comme la rampe ou la transition minimale', () => {
    for (const [name, cover] of COVERS) {
      const { days, most, slope } = year(CLIMATES[name], cover);
      const limit = Math.max(most / SEASONS.minTransition, slope) / 10 + 1e-12;
      for (let index = 1; index <= days.length; index++) {
        const before = days[index - 1]?.share ?? 0;
        const after = days[index % days.length]?.share ?? 0;
        expect(Math.abs(after - before), `${name}, ${cover}, ${String(index)}`).toBeLessThanOrEqual(
          limit,
        );
      }
      // Chaque droite du calendrier dure au moins minTransition jours.
      const bytes = bytesOf(CLIMATES[name], cover);
      if (bytes[1] > 0) {
        expect(bytes[2]).toBeGreaterThanOrEqual(SEASONS.minTransition);
        expect(bytes[3]).toBeGreaterThanOrEqual(SEASONS.minTransition);
      }
    }
  });

  it('ne pose ni neige ni glace sous les tropiques', () => {
    for (const cover of ['snow', 'ice', 'sea-ice'] as const) {
      const { days, bytes } = year(CLIMATES.tropics, cover);
      expect(bytes, cover).toEqual(RAMP_ONLY);
      expect(days.every((day) => day.share === 0)).toBe(true);
    }
  });

  it('suit ses réglages : un retard maximal moindre, une fenêtre d’été plus longue', () => {
    const variant = (change: (seasons: Seasons) => Seasons) =>
      loadSettings('variante de data/seasons.json', SeasonsSchema, change(SEASONS));
    const short = variant((seasons) => ({ ...seasons, snow: { ...seasons.snow, maxLag: 10 } }));
    const plain = year(CLIMATES.plain, 'snow');
    const shorter = year(CLIMATES.plain, 'snow', short);
    expect(shorter.last(0)).toBeLessThanOrEqual(plain.last(0, 'ramp') + 10 + 0.1);
    expect(shorter.last(0)).toBeLessThan(plain.last(0));
    const summer = variant((seasons) => ({ ...seasons, summerDays: 100 }));
    const alpine = year(CLIMATES.alpine, 'snow', summer);
    expect(alpine.days.some((day) => day.phase >= 310 && day.share > 0)).toBe(true);
    for (const day of alpine.days) if (day.phase >= 310) expect(day.share).toBe(day.ramp);
  });
});

describe('calendriers d’un monde', () => {
  /** Un monde de quelques lignes : chaque climat de CLIMATES, au nord puis au sud en miroir. */
  function mirrored() {
    const size = { width: 8, height: 4 };
    const layers = emptyLayers(size);
    const ocean = testData.biomes.indexOf('coastal-ocean') ?? 0;
    const lake = testData.biomes.indexOf('lake') ?? 0;
    const tundra = testData.biomes.indexOf('tundra') ?? 0;
    const entries = Object.values(CLIMATES).slice(0, size.width);
    for (let y = 0; y < size.height; y++) {
      // Lignes 0 et 3, 1 et 2 : symétriques autour de l'équateur, à la même saison des pluies.
      for (let x = 0; x < size.width; x++) {
        const cell = y * size.width + x;
        const entry = entries[x] ?? CLIMATES.plain;
        layers.temperature[cell] = Math.round(codeTemperature(entry.temperature) * 10);
        layers.amplitude[cell] = Math.round(codeAmplitude(entry.amplitude) * 10);
        layers.precipitation[cell] = entry.precipitation * RAIN_STEP;
        layers.biome[cell] = x === 3 ? ocean : x === 7 ? lake : tundra;
      }
    }
    return { size, layers };
  }

  it('donne au sud le calendrier du nord, sa phase décalée de six mois', () => {
    const { size, layers } = mirrored();
    const bytes = worldCalendars(size, layers, testData.biomes.entries, SEASONS);
    const count = size.width * size.height;
    expect(bytes).toHaveLength(count * 2 * CALENDAR_BYTES);
    for (let x = 0; x < size.width; x++) {
      for (const [north, south] of [
        [x, 3 * size.width + x],
        [size.width + x, 2 * size.width + x],
      ] as const) {
        for (const at of [snowAt, (cell: number) => iceAt(cell, count)]) {
          const a = Array.from(bytes.subarray(at(north), at(north) + CALENDAR_BYTES));
          const b = Array.from(bytes.subarray(at(south), at(south) + CALENDAR_BYTES));
          expect(b).toEqual(a);
          // Le même jour de l'année, le sud vit la saison du nord six mois plus tôt.
          for (let day = 0; day < YEAR_DAYS; day += 7.3) {
            expect(calendarLevel(bytes, at(south), phaseDay(day + 180, true))).toBeCloseTo(
              calendarLevel(bytes, at(north), phaseDay(day, false)),
              12,
            );
          }
        }
      }
    }
  });

  it('range pour chaque case le calendrier de son climat arrondi et de sa sorte de glace', () => {
    const { size, layers } = mirrored();
    const bytes = worldCalendars(size, layers, testData.biomes.entries, SEASONS);
    const count = size.width * size.height;
    for (let cell = 0; cell < count; cell++) {
      const at = cellClimate(layers, cell, size.width, size.height);
      const biome = testData.biomes.entries.at(layers.biome[cell] ?? 0);
      const snow = calendarBytes(snowCalendar(at, SEASONS));
      const ice = calendarBytes(iceCalendar(at, biome?.seasons.cover === 'sea-ice', SEASONS));
      expect(Array.from(bytes.subarray(snowAt(cell), snowAt(cell) + 4))).toEqual(snow);
      expect(Array.from(bytes.subarray(iceAt(cell, count), iceAt(cell, count) + 4))).toEqual(ice);
    }
  });

  it("donne les mêmes octets d'un appel à l'autre, quel que soit l'ordre des cases", () => {
    const world = testWorld('graine');
    const size = WORLD_SIZES.small;
    const biomes = testData.biomes.entries;
    const first = worldCalendars(size, world, biomes, SEASONS);
    expect(worldCalendars(size, world, biomes, SEASONS)).toEqual(first);
    // Le monde décalé d'une demi-largeur, ligne par ligne : chaque case garde ses octets.
    const shifted = testWorld('graine');
    const half = size.width / 2;
    for (const name of ['temperature', 'amplitude', 'precipitation', 'biome'] as const) {
      const layer = shifted[name];
      for (let y = 0; y < size.height; y++) {
        const row = world[name].slice(y * size.width, (y + 1) * size.width);
        for (let x = 0; x < size.width; x++) {
          layer[y * size.width + ((x + half) % size.width)] = row[x] ?? 0;
        }
      }
    }
    const moved = worldCalendars(size, shifted, biomes, SEASONS);
    const count = size.width * size.height;
    for (let cell = 0; cell < count; cell += 97) {
      const x = cell % size.width;
      const to = cell - x + ((x + half) % size.width);
      for (const at of [snowAt, (index: number) => iceAt(index, count)]) {
        expect(moved.subarray(at(to), at(to) + 4)).toEqual(first.subarray(at(cell), at(cell) + 4));
      }
    }
  });

  it('tient ses bornes sur chaque case d’un vrai monde, jour après jour', () => {
    const world = testWorld('graine');
    const size = WORLD_SIZES.small;
    const count = size.width * size.height;
    const bytes = worldCalendars(size, world, testData.biomes.entries, SEASONS);
    const ramps = coverRamps(SEASONS);
    const half = SEASONS.summerDays / 2;
    let covered = 0;
    let lingering = 0;
    for (let cell = 0; cell < count; cell++) {
      const biome = testData.biomes.entries.at(world.biome[cell] ?? 0);
      const cover = biome?.seasons.cover ?? 'none';
      if (cover === 'none') continue;
      const ramp = ramps[cover];
      const annual = codeTemperature(encodeTemperature((world.temperature[cell] ?? 0) / 10));
      const amplitude = codeAmplitude(encodeAmplitude((world.amplitude[cell] ?? 0) / 10));
      const most = coverShare(ramp, annual - amplitude);
      if (most <= 0) continue;
      covered++;
      const floor = coverShare(ramp, annual + amplitude);
      const at = cover === 'snow' ? snowAt(cell) : iceAt(cell, count);
      for (let phase = 0; phase < YEAR_DAYS; phase += 1) {
        const daily = annual + amplitude * cos((TAU * phase) / YEAR_DAYS);
        const r = coverShare(ramp, daily);
        const share = composeCover(
          ramp,
          annual,
          amplitude,
          daily,
          phase,
          calendarLevel(bytes, at, phase),
        );
        if (phase < COLDEST_PHASE && share > r + 1e-9) throw new Error(`case ${String(cell)}`);
        if (phase >= COLDEST_PHASE && share < r - 1e-9) throw new Error(`case ${String(cell)}`);
        if (phase >= YEAR_DAYS - half && share !== r) {
          throw new Error(`été, case ${String(cell)}, ${String(phase)}`);
        }
        if (share < floor - 1e-9) throw new Error(`plancher, case ${String(cell)}`);
        if (phase === 300 && share > r + 0.05) lingering++;
      }
    }
    // Des milliers de cases couvertes, dont la neige ou la glace traîne à la mi-mai du nord.
    expect(covered).toBeGreaterThan(10_000);
    expect(lingering).toBeGreaterThan(1_000);
  });

  it('fige les calendriers de climats écrits ici', () => {
    const fingerprint = new Fingerprint();
    for (let annual = -24; annual <= 12; annual += 2.5) {
      for (const amplitude of [0, 2, 6.125, 11.375, 18]) {
        for (const precipitation of [40, 300, 900, 2400]) {
          for (const rain of [0, 30, 90]) {
            const at = climate(annual, amplitude, precipitation, rain);
            fingerprint.uint32(snowCalendar(at, SEASONS));
            fingerprint.uint32(iceCalendar(at, false, SEASONS));
            fingerprint.uint32(iceCalendar(at, true, SEASONS));
          }
        }
      }
    }
    expect(fingerprint.hex()).toBe('5918874f');
  });
});
