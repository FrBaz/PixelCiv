/**
 * La couverture que voit la simulation (tâche 2b.7 ; C1, D9 ; SAI-03 ; ADR 0019, § 1) : la part
 * d'une case que couvrent la neige de ses terres, la glace de son eau ou la banquise, au jour où
 * la pêche se fait. C'est la part que montre la carte, de la même composition (src/core/snow.ts,
 * composeCover), sur les mêmes octets (les calendriers de l'état, envoyés au rendu) et les mêmes
 * entrées arrondies (les codes de la texture des saisons) : la pêche gèle et dégèle quand la
 * carte gèle et dégèle. La pêche (forage.ts) la lit ici, d'une seule fonction, que le test de la
 * cause des empreintes remplace par la rampe de l'instant de 7c893a7 (cover.test.ts).
 */
import type { CoverRamp } from '../core/seasons';
import {
  calendarLevel,
  codeAmplitude,
  codeTemperature,
  composeCover,
  encodeAmplitude,
  encodeTemperature,
  iceAt,
  snowAt,
  type CalendarCover,
} from '../core/snow';
import type { WorldLayers } from '../core/world';

/**
 * Part couverte de la case `cell` par sa couverture `cover` (de rampe `ramp`), au facteur de
 * saison `season` de sa ligne (signé selon l'hémisphère) et au jour de phase `phase` de sa
 * moitié du monde, selon ses calendriers `calendars` (src/core/snow.ts, worldCalendars).
 */
export function fishingCover(
  world: WorldLayers,
  calendars: Uint8Array,
  cell: number,
  cover: CalendarCover,
  ramp: CoverRamp,
  season: number,
  phase: number,
): number {
  const at = cover === 'snow' ? snowAt(cell) : iceAt(cell, world.biome.length);
  const annual = codeTemperature(encodeTemperature((world.temperature[cell] ?? 0) / 10));
  const amplitude = codeAmplitude(encodeAmplitude((world.amplitude[cell] ?? 0) / 10));
  const daily = annual + amplitude * season;
  return composeCover(ramp, annual, amplitude, daily, phase, calendarLevel(calendars, at, phase));
}
