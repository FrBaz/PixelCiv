import { describe, expect, it } from 'vitest';
import { testData } from '../sim/testing';
import { cos, TAU } from './dmath';
import {
  cellMedianThreshold,
  coldDates,
  dryDate,
  FOLIAGE_BYTES,
  FOLIAGE_STATE,
  FOLIAGE_UNIT,
  foliageShares,
  foliageState,
  leafHash,
  leafThreshold,
  lightDate,
  NO_DATE,
  worldFoliage,
  type FoliageRules,
} from './foliage';
import { Fingerprint } from './hash';
import { latitude, rainSeasonality } from './seasons';
import { COLDEST_PHASE, phaseDay, YEAR_DAYS } from './snow';
import { emptyLayers } from './world';

const RULES: FoliageRules = { foliage: testData.decor.foliage, seasons: testData.seasons };
const TRANSITION = RULES.seasons.minTransition;
const { bareBelow, autumnBelow, autumnDrop, dryShare } = RULES.foliage;

/** Les octets du calendrier d'un climat (°C) à la latitude `lat`. */
function bytesOf(annual: number, amplitude: number, lat = 0.4): number[] {
  const cold = coldDates(annual, amplitude, RULES);
  return [cold & 255, cold >>> 8, dryDate(rainSeasonality(lat), RULES), lightDate(lat, RULES)];
}

/** Les parts des états, au dixième de jour, sur l'année. */
function year(bytes: readonly number[]) {
  return Array.from({ length: YEAR_DAYS * 10 }, (_, index) => {
    const phase = index / 10;
    return { phase, ...foliageShares(bytes, 0, phase, TRANSITION) };
  });
}

/**
 * Des climats de part et d'autre des seuils : des feuillus dont le mois le plus froid est entre 4
 * et 5 °C (la critique, requis 1 : la végétation y sautait en plein hiver), une forêt tempérée,
 * une forêt froide, des toundras (dont une au mois le plus chaud sous le bois nu), un hiver doux,
 * une steppe, les tropiques.
 */
const CLIMATES: Readonly<Record<string, readonly [number, number]>> = {
  mildWinter45: [12, 7.5],
  barelyBare: [35, 30.125],
  mildWinter41: [10.5, 6.4],
  mildWinter49: [14, 9.1],
  temperate: [8, 12],
  cold: [-2, 18],
  tundra: [-10, 15],
  coldTundra: [-14, 14.25],
  alpine: [-4, 6],
  steppe: [6, 16],
  oceanic: [12, 5],
  tropics: [25, 1.5],
};

describe('calendrier de la végétation (ADR 0019, § 2)', () => {
  it('change chaque état d’au plus 1 / transition par jour, toute l’année', () => {
    for (const [name, [annual, amplitude]] of Object.entries(CLIMATES)) {
      for (const lat of [0.1, 0.2, 0.3, 0.45, 0.8]) {
        const days = year(bytesOf(annual, amplitude, lat));
        for (let index = 1; index <= days.length; index++) {
          const before = days.at(index - 1);
          const after = days.at(index % days.length);
          if (before === undefined || after === undefined) continue;
          for (const key of ['autumn', 'bare', 'dry', 'light'] as const) {
            expect(
              Math.abs(after[key] - before[key]),
              `${name}, ${String(lat)}, ${key}, jour ${String(before.phase)}`,
            ).toBeLessThanOrEqual(0.1 / TRANSITION + 1e-9);
          }
        }
      }
    }
  });

  it('ne change rien au cœur de l’été, même là où le mois le plus chaud reste sous le bois nu', () => {
    const half = RULES.seasons.summerDays / 2;
    for (const [name, [annual, amplitude]] of Object.entries(CLIMATES)) {
      for (const day of year(bytesOf(annual, amplitude, 0.9))) {
        const distance = Math.min(day.phase, YEAR_DAYS - day.phase);
        if (distance > half) continue;
        expect([day.autumn, day.bare, day.dry, day.light], `${name}, ${String(day.phase)}`).toEqual(
          [0, 0, 0, 0],
        );
      }
    }
    // Une toundra dont le mois le plus chaud ne passe pas le seuil du bois nu : nue toute l'année
    // hors de l'été, où elle reverdit (le saule nain de 2b.6 restait nu même en juillet).
    const tundra = year(bytesOf(-14, 14.25));
    expect(tundra.find((day) => day.phase === 90)?.bare).toBe(1);
    expect(tundra.find((day) => day.phase === 0)?.bare).toBe(0);
  });

  it('mène l’automne au bois nu ou l’éteint par une rampe, jamais d’un coup, ni au printemps', () => {
    for (const [name, [annual, amplitude]] of Object.entries(CLIMATES)) {
      const days = year(bytesOf(annual, amplitude));
      for (const day of days) {
        // Au réchauffement, l'automne ne dépasse jamais le bois nu : aucun pixel n'y revire.
        if (day.phase > COLDEST_PHASE) {
          expect(day.autumn, `${name}, ${String(day.phase)}`).toBeLessThanOrEqual(day.bare + 1e-12);
        }
      }
      // Au jour le plus froid, rien ne bascule : les parts de part et d'autre se suivent.
      const before = days.find((day) => day.phase === COLDEST_PHASE - 0.1);
      const after = days.find((day) => day.phase === COLDEST_PHASE + 0.1);
      expect(Math.abs((before?.autumn ?? 0) - (after?.autumn ?? 0))).toBeLessThanOrEqual(
        0.2 / TRANSITION + 1e-9,
      );
    }
    // Des feuillus dont le mois le plus froid touche à peine le seuil (4,875 °C, une grande
    // amplitude) : roux, puis en partie nus au cœur de l'hiver, et le reste reverdit peu à peu (la
    // critique : 44 % des pixels repassaient au vert d'un coup au jour le plus froid).
    const mild = year(bytesOf(35, 30.125));
    const peak = mild.find((day) => day.phase === COLDEST_PHASE);
    expect(peak?.bare).toBeGreaterThan(0.5);
    expect(peak?.bare).toBeLessThan(1);
    expect(Math.max(...mild.map((day) => day.autumn))).toBe(1);
  });

  it('suit les seuils du feuillage du décor de 2b.6 au pixel médian, hors de l’été', () => {
    // À mi-part, chaque état bascule le jour où la température (ou la pluie) passe son seuil, à
    // une unité de date près, sauf s'il touche les jours de l'été.
    const half = (RULES.seasons.summerDays + TRANSITION) / 2;
    for (const [name, [annual, amplitude]] of Object.entries(CLIMATES)) {
      const days = year(bytesOf(annual, amplitude, 0.2));
      const rain = rainSeasonality(0.2);
      for (const day of days) {
        const distance = Math.min(day.phase, YEAR_DAYS - day.phase);
        if (distance < half + FOLIAGE_UNIT) continue;
        const g = cos((TAU * day.phase) / YEAR_DAYS);
        const monthly = annual + amplitude * g;
        const coldest = annual - amplitude;
        const warmest = annual + amplitude;
        // Loin des seuils (un jour de pente au moins), l'état est celui de la règle de 2b.6.
        const slope = (amplitude * TAU) / YEAR_DAYS;
        const near = (threshold: number) => Math.abs(monthly - threshold) < 1.2 * slope + 0.3;
        if (near(bareBelow) || near(autumnBelow) || near(warmest - autumnDrop)) continue;
        const where = `${name}, jour ${String(day.phase)}`;
        expect(day.bare > 0.5, where).toBe(coldest < bareBelow && monthly < bareBelow);
        const cooling = day.phase < COLDEST_PHASE;
        const autumn =
          coldest < bareBelow &&
          cooling &&
          monthly < autumnBelow &&
          monthly <= warmest - autumnDrop &&
          monthly >= bareBelow;
        if (autumn) expect(day.autumn > 0.5, where).toBe(true);
        if (Math.abs(1 + rain * g - dryShare) > 1.2 * ((rain * TAU) / YEAR_DAYS) + 0.01) {
          expect(day.dry > 0.5, where).toBe(1 + rain * g < dryShare);
        }
      }
    }
  });

  it('suit l’hémisphère par la phase : le sud vit le calendrier du nord six mois plus tard', () => {
    const size = { width: 1, height: 8 };
    const layers = emptyLayers(size);
    layers.temperature.fill(80);
    layers.amplitude.fill(120);
    const bytes = worldFoliage(size, layers, RULES);
    // Les lignes symétriques de part et d'autre de l'équateur ont la même latitude.
    for (let y = 0; y < 4; y++) {
      expect(latitude(y, 8)).toBeCloseTo(latitude(7 - y, 8), 12);
      expect(Array.from(bytes.subarray(y * 4, y * 4 + 4))).toEqual(
        Array.from(bytes.subarray((7 - y) * 4, (7 - y) * 4 + 4)),
      );
    }
    for (let day = 0; day < YEAR_DAYS; day += 7) {
      const north = foliageShares(bytes, 0, phaseDay(day, false), TRANSITION);
      const south = foliageShares(bytes, 7 * 4, phaseDay(day + YEAR_DAYS / 2, true), TRANSITION);
      expect(south).toEqual(north);
    }
  });

  it('ne dénude rien sous les tropiques, y sèche à la saison sèche, et ne donne la lumière d’hiver qu’aux latitudes du réglage', () => {
    const [autumn, bare] = bytesOf(25, 1.5, 0.2);
    expect([autumn, bare]).toEqual([NO_DATE, NO_DATE]);
    // Un hiver doux, au-dessus du seuil du bois nu : ni automne ni bois nu (règle de 2b.6).
    expect(bytesOf(12, 5).slice(0, 2)).toEqual([NO_DATE, NO_DATE]);
    // La saison sèche des tropiques, vers 18° ; aucune à l'équateur, où il pleut toute l'année.
    expect(dryDate(rainSeasonality(0.2), RULES)).not.toBe(NO_DATE);
    expect(dryDate(rainSeasonality(0), RULES)).toBe(NO_DATE);
    expect(dryDate(0, RULES)).toBe(NO_DATE);
    // La lumière d'hiver : rien sous `from`, au plus long à `to` et au-delà.
    const { from, to } = RULES.seasons.light;
    expect(lightDate(from, RULES)).toBe(NO_DATE);
    expect(lightDate(from - 0.1, RULES)).toBe(NO_DATE);
    const middle = lightDate((from + to) / 2, RULES);
    const full = lightDate(to, RULES);
    expect(full).toBeLessThan(middle);
    expect(lightDate(0.95, RULES)).toBe(full);
    // Au plus long, la fenêtre commence quand le facteur de saison passe sous `factor`.
    const day = full * FOLIAGE_UNIT;
    expect(cos((TAU * day) / YEAR_DAYS)).toBeCloseTo(RULES.seasons.light.factor, 2);
  });

  it('donne les mêmes octets quel que soit l’ordre des cases, et ceux de leur climat', () => {
    const size = { width: 16, height: 16 };
    const layers = emptyLayers(size);
    for (let cell = 0; cell < 256; cell++) {
      layers.temperature[cell] = ((cell * 37) % 400) - 150;
      layers.amplitude[cell] = (cell * 11) % 200;
    }
    const bytes = worldFoliage(size, layers, RULES);
    for (let cell = 0; cell < 256; cell++) {
      const y = Math.floor(cell / 16);
      const lat = latitude(y, 16);
      const expected = [
        ...(() => {
          const cold = coldDates(
            (layers.temperature[cell] ?? 0) / 10,
            (layers.amplitude[cell] ?? 0) / 10,
            RULES,
          );
          return [cold & 255, cold >>> 8];
        })(),
        dryDate(rainSeasonality(lat), RULES),
        lightDate(lat, RULES),
      ];
      expect(Array.from(bytes.subarray(cell * FOLIAGE_BYTES, (cell + 1) * FOLIAGE_BYTES))).toEqual(
        expected,
      );
    }
    // L'empreinte des calendriers de ces climats, aux réglages écrits ici : les mêmes octets sur
    // tous les navigateurs (dmath).
    const written: FoliageRules = {
      foliage: { bareBelow: 5, autumnBelow: 12, autumnDrop: 3, dryShare: 0.65 },
      seasons: {
        minTransition: 12,
        summerDays: 30,
        light: { from: 0.25, to: 0.5, factor: -0.3, toward: '#5d6b86', mix: 0.25, scale: 0.94 },
      },
    };
    expect(new Fingerprint().typedArray(worldFoliage(size, layers, written)).hex()).toBe(
      '7d502fcd',
    );
  });

  it('donne à chaque pixel un seuil sans motif, et à chaque case celui de sa majorité', () => {
    // Le hachage reste dans les entiers que les flottants de 32 bits du GPU calculent exactement.
    expect((4095 * 97 + 2047 * 61) * 1).toBeLessThan(2 ** 24);
    const counts = new Array<number>(16).fill(0);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const hash = leafHash(x, y);
        expect(hash).toBeGreaterThanOrEqual(0);
        expect(hash).toBeLessThan(256);
        counts[Math.floor(leafThreshold(x, y) * 16)]++;
      }
    }
    // Une répartition uniforme, à 5 % près par seizième.
    for (const count of counts) expect(Math.abs(count / (512 * 32) - 1)).toBeLessThan(0.05);
    // La majorité d'une case (9 pixels sur 16 au moins), quand elle existe, est l'état de son
    // seuil médian : pour des parts quelconques, sur des cases quelconques.
    const states = { autumn: true, bare: true, dry: true };
    let decided = 0;
    for (let cell = 0; cell < 400; cell++) {
      const cx = (cell * 7) % 97;
      const cy = (cell * 13) % 53;
      const median = cellMedianThreshold(cx, cy);
      for (const bare of [0, 0.2, 0.45, 0.5, 0.55, 0.8, 1]) {
        for (const autumn of [0, 0.3, 0.5, 0.6, 1]) {
          const shares = { autumn, bare, dry: 0.7, light: 0.9 };
          const tally = new Map<number, number>();
          for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) {
              const state = foliageState(
                shares,
                states,
                leafThreshold(cx * 4 + i, cy * 4 + j),
                true,
              );
              tally.set(state, (tally.get(state) ?? 0) + 1);
            }
          }
          for (const [state, count] of tally) {
            if (count < 9) continue;
            decided++;
            expect(foliageState(shares, states, median, true)).toBe(state);
          }
        }
      }
    }
    expect(decided).toBeGreaterThan(5000);
    expect(FOLIAGE_STATE.summer).toBe(-1);
  });
});
