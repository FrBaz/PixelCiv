/**
 * La couverture que voit la simulation (tâche 2b.7 ; C1, D9 ; SAI-03 ; ADR 0019, § 1) : la part
 * d'une case que couvrent la neige de ses terres, la glace de son eau ou la banquise, au jour où
 * la pêche se fait. La pêche (forage.ts) la lit ici, d'une seule fonction, que le test de la cause
 * des empreintes remplace par la rampe de l'instant (cover.test.ts).
 */
import type { CoverRamp } from '../core/seasons';
import { coverShare } from '../core/seasons';
import type { CalendarCover } from '../core/snow';
import type { WorldLayers } from '../core/world';

/**
 * Part couverte de la case `cell` par sa couverture `cover` (de rampe `ramp`), au facteur de
 * saison `season` de sa ligne (signé selon l'hémisphère) et au jour de phase `phase` de sa
 * moitié du monde, selon ses calendriers `calendars` (src/core/snow.ts, worldCalendars). Pour
 * l'instant, la rampe de l'instant, comme en 7c893a7 : l'état n'a pas encore changé.
 */
export function fishingCover(
  world: WorldLayers,
  _calendars: Uint8Array,
  cell: number,
  _cover: CalendarCover,
  ramp: CoverRamp,
  season: number,
  _phase: number,
): number {
  const temperature = ((world.temperature[cell] ?? 0) + (world.amplitude[cell] ?? 0) * season) / 10;
  return coverShare(ramp, temperature);
}
