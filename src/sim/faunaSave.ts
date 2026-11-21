/**
 * Sauvegarde du gibier (version 8 du format, tâche 2b.6, ADR 0007 et ADR 0018) : ses colonnes,
 * empaquetées en huit tableaux typés, et, dans les données JSON, les compteurs d'identifiants et
 * les identifiants des espèces, que la relecture ramène au contenu d'aujourd'hui, comme ceux des
 * biomes. La relecture vérifie tout ce qu'elle reprend ; elle ne juge pas la franchissabilité des
 * cases, qui suit un contenu qui a pu changer (ADR 0007).
 */
import type { Catalog } from '../core/data/catalog';
import type { FaunaSpecies } from '../core/data/fauna';
import { MAX_HERD } from '../core/data/fauna';
import { FAUNA_GAIT } from '../core/protocol';
import { FIXED } from '../core/position';
import type { WorldSize } from '../core/world';
import { Fauna, rebuildFauna } from './fauna';
import { MAX_LEG_DAYS, MAX_STEP } from './movement';

const NO = -1;
/** Entiers par animal dans faunaInts : harde, naissance, x, y, place x, place y, pas x, pas y, départ, chasseur. */
const ANIMAL_INTS = 10;
/** Octets par animal dans faunaBytes : vivant, espèce, sexe, allure. */
const ANIMAL_BYTES = 4;
/** Entiers par harde dans herdInts : identifiant, centre x, centre y, but x, but y, prochain but, calme. */
const HERD_INTS = 7;
/** Octets par harde dans herdBytes : vivante, espèce. */
const HERD_BYTES = 2;
/**
 * Animaux, au plus, qu'une sauvegarde peut porter, par case du monde : la borne du format, au-dessus
 * du plafond du jeu (MAX_FAUNA_SHARE), pour qu'un plafond abaissé plus tard ne rende pas illisible
 * une partie plus peuplée ; le mois suivant la ramène à ses cibles.
 */
export const SAVED_FAUNA_SHARE = 1 / 32;

type FaunaArray =
  | Int32Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer>
  | Uint8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>;

export interface SavedFauna {
  readonly json: {
    readonly nextId: number;
    readonly nextHerdId: number;
    readonly species: readonly string[];
  };
  readonly arrays: Record<string, FaunaArray>;
}

/** Le gibier, empaqueté : quatre tableaux pour les animaux, deux pour les hardes, deux piles. */
export function saveFauna(
  fauna: Fauna,
  content: { readonly fauna: Catalog<FaunaSpecies> },
): SavedFauna {
  const n = fauna.end;
  const ints = new Int32Array(n * ANIMAL_INTS);
  const bytes = new Uint8Array(n * ANIMAL_BYTES);
  const ids = new Uint32Array(n);
  const days = new Uint16Array(n);
  for (let slot = 0; slot < n; slot++) {
    if (fauna.alive[slot] !== 1) continue;
    const at = slot * ANIMAL_INTS;
    ints[at] = fauna.herd[slot] ?? NO;
    ints[at + 1] = fauna.born[slot] ?? 0;
    ints[at + 2] = fauna.x[slot] ?? 0;
    ints[at + 3] = fauna.y[slot] ?? 0;
    ints[at + 4] = fauna.placeX[slot] ?? 0;
    ints[at + 5] = fauna.placeY[slot] ?? 0;
    ints[at + 6] = fauna.stepX[slot] ?? 0;
    ints[at + 7] = fauna.stepY[slot] ?? 0;
    ints[at + 8] = fauna.depart[slot] ?? NO;
    ints[at + 9] = (fauna.hunter[slot] ?? 0) | 0;
    bytes[slot * ANIMAL_BYTES] = 1;
    bytes[slot * ANIMAL_BYTES + 1] = fauna.species[slot] ?? 0;
    bytes[slot * ANIMAL_BYTES + 2] = fauna.sex[slot] ?? 0;
    bytes[slot * ANIMAL_BYTES + 3] = fauna.gait[slot] ?? 0;
    ids[slot] = fauna.id[slot] ?? 0;
    days[slot] = fauna.stepDays[slot] ?? 0;
  }
  const h = fauna.herdEnd;
  const herdInts = new Int32Array(h * HERD_INTS);
  const herdBytes = new Uint8Array(h * HERD_BYTES);
  for (let herd = 0; herd < h; herd++) {
    if (fauna.herdAlive[herd] !== 1) continue;
    const at = herd * HERD_INTS;
    herdInts[at] = (fauna.herdId[herd] ?? 0) | 0;
    herdInts[at + 1] = fauna.homeX[herd] ?? 0;
    herdInts[at + 2] = fauna.homeY[herd] ?? 0;
    herdInts[at + 3] = fauna.goalX[herd] ?? 0;
    herdInts[at + 4] = fauna.goalY[herd] ?? 0;
    herdInts[at + 5] = fauna.next[herd] ?? 0;
    herdInts[at + 6] = fauna.calm[herd] ?? 0;
    herdBytes[herd * HERD_BYTES] = 1;
    herdBytes[herd * HERD_BYTES + 1] = fauna.herdSpecies[herd] ?? 0;
  }
  return {
    json: {
      nextId: fauna.nextId,
      nextHerdId: fauna.nextHerdId,
      species: content.fauna.entries.map((entry) => entry.id),
    },
    arrays: {
      faunaInts: ints,
      faunaBytes: bytes,
      faunaIds: ids,
      faunaDays: days,
      faunaFree: Int32Array.from(fauna.free),
      herdInts,
      herdBytes,
      herdFree: Int32Array.from(fauna.herdFree),
    },
  };
}

/** Le gibier d'une sauvegarde est abîmé : la relecture en fait une SaveError (« corrupt »). */
export class FaunaSaveError extends Error {
  override readonly name = 'FaunaSaveError';
}

/** Les espèces sauvegardées, ramenées à leurs rangs d'aujourd'hui ; une espèce disparue n'en a pas. */
function speciesTable(saved: unknown, catalog: Catalog<FaunaSpecies>): (number | undefined)[] {
  if (!Array.isArray(saved) || saved.length > 16) throw new FaunaSaveError('espèces illisibles');
  return (saved as unknown[]).map((id) =>
    typeof id === 'string' ? catalog.indexOf(id) : undefined,
  );
}

/**
 * Le gibier d'une sauvegarde, vérifié : tableaux du bon type et de la bonne taille, espèces
 * connues, vivants de 0 ou 1, hardes vivantes et de la même espèce que leurs membres, positions,
 * places, centres et buts dans le monde, étape lisible (MAX_LEG_DAYS, MAX_STEP, fin dans le monde),
 * allure connue, identifiants positifs sous leurs compteurs, piles libres sans doublon ni vivant,
 * hardes de MAX_HERD membres au plus, et pas plus d'animaux que le format n'en admet.
 */
export function restoreFauna(
  json: unknown,
  arrays: Readonly<Record<string, unknown>>,
  content: { readonly fauna: Catalog<FaunaSpecies> },
  size: WorldSize,
): Fauna {
  const fail = (what: string): never => {
    throw new FaunaSaveError(`gibier : ${what}`);
  };
  if (typeof json !== 'object' || json === null) return fail('illisible');
  const { nextId, nextHerdId, species } = json as Record<string, unknown>;
  if (typeof nextId !== 'number' || !Number.isInteger(nextId) || nextId < 1 || nextId > 0xffffffff)
    return fail('compteur des animaux');
  if (
    typeof nextHerdId !== 'number' ||
    !Number.isInteger(nextHerdId) ||
    nextHerdId < 1 ||
    nextHerdId > 0xffffffff
  )
    return fail('compteur des hardes');
  const remap = speciesTable(species, content.fauna);
  const { faunaInts: ints, faunaBytes: bytes, faunaIds: ids, faunaDays: days } = arrays;
  const { faunaFree: free, herdInts, herdBytes, herdFree } = arrays;
  if (
    !(ints instanceof Int32Array) ||
    !(bytes instanceof Uint8Array) ||
    !(ids instanceof Uint32Array) ||
    !(days instanceof Uint16Array) ||
    !(free instanceof Int32Array)
  )
    return fail('colonnes des animaux');
  if (
    !(herdInts instanceof Int32Array) ||
    !(herdBytes instanceof Uint8Array) ||
    !(herdFree instanceof Int32Array)
  )
    return fail('colonnes des hardes');
  const n = ids.length;
  if (ints.length !== n * ANIMAL_INTS || bytes.length !== n * ANIMAL_BYTES || days.length !== n)
    return fail('tailles des colonnes');
  if (herdBytes.length % HERD_BYTES !== 0) return fail('tailles des hardes');
  const h = herdBytes.length / HERD_BYTES;
  if (herdInts.length !== h * HERD_INTS) return fail('tailles des hardes');
  const most = Math.floor(size.width * size.height * SAVED_FAUNA_SHARE);
  if (n > most || h > most) return fail("trop d'animaux");
  const span = size.width * FIXED;
  const tall = size.height * FIXED;
  const inside = (x: number, y: number) => x >= 0 && x < span && y >= 0 && y < tall;
  const fauna = new Fauna();
  fauna.ensure(n);
  fauna.ensureHerds(h);
  fauna.end = n;
  fauna.herdEnd = h;
  fauna.nextId = nextId;
  fauna.nextHerdId = nextHerdId;
  for (let herd = 0; herd < h; herd++) {
    const alive = herdBytes[herd * HERD_BYTES] ?? 0;
    if (alive > 1) return fail('harde ni vivante ni libre');
    if (alive === 0) continue;
    const s = remap[herdBytes[herd * HERD_BYTES + 1] ?? 0];
    if (s === undefined) return fail('espèce inconnue');
    const at = herd * HERD_INTS;
    const id = (herdInts[at] ?? 0) >>> 0;
    if (id === 0 || id >= nextHerdId) return fail('identifiant de harde');
    fauna.herdAlive[herd] = 1;
    fauna.herdCount++;
    fauna.herdSpecies[herd] = s;
    fauna.herdId[herd] = id;
    fauna.homeX[herd] = herdInts[at + 1] ?? 0;
    fauna.homeY[herd] = herdInts[at + 2] ?? 0;
    fauna.goalX[herd] = herdInts[at + 3] ?? 0;
    fauna.goalY[herd] = herdInts[at + 4] ?? 0;
    fauna.next[herd] = herdInts[at + 5] ?? 0;
    fauna.calm[herd] = herdInts[at + 6] ?? 0;
    const homeX = fauna.homeX[herd] ?? 0;
    const homeY = fauna.homeY[herd] ?? 0;
    if (homeX < 0 || homeX >= size.width || homeY < 0 || homeY >= size.height)
      return fail('domaine hors du monde');
    if (!inside(fauna.goalX[herd] ?? 0, fauna.goalY[herd] ?? 0)) return fail('but hors du monde');
  }
  const members = new Uint16Array(h);
  for (let slot = 0; slot < n; slot++) {
    const alive = bytes[slot * ANIMAL_BYTES] ?? 0;
    if (alive > 1) return fail('animal ni vivant ni libre');
    if (alive === 0) continue;
    const s = remap[bytes[slot * ANIMAL_BYTES + 1] ?? 0];
    if (s === undefined) return fail('espèce inconnue');
    const at = slot * ANIMAL_INTS;
    const herd = ints[at] ?? NO;
    if (herd < 0 || herd >= h || fauna.herdAlive[herd] !== 1 || fauna.herdSpecies[herd] !== s)
      return fail("harde de l'animal");
    if ((members[herd] = (members[herd] ?? 0) + 1) > MAX_HERD) return fail('harde trop grande');
    const id = ids[slot] ?? 0;
    if (id === 0 || id >= nextId) return fail("identifiant d'animal");
    const sex = bytes[slot * ANIMAL_BYTES + 2] ?? 0;
    const gait = bytes[slot * ANIMAL_BYTES + 3] ?? 0;
    if (sex > 1) return fail('sexe');
    if (gait > FAUNA_GAIT.run) return fail('allure');
    fauna.alive[slot] = 1;
    fauna.count++;
    fauna.id[slot] = id;
    fauna.species[slot] = s;
    fauna.herd[slot] = herd;
    fauna.born[slot] = ints[at + 1] ?? 0;
    fauna.x[slot] = ints[at + 2] ?? 0;
    fauna.y[slot] = ints[at + 3] ?? 0;
    fauna.placeX[slot] = ints[at + 4] ?? 0;
    fauna.placeY[slot] = ints[at + 5] ?? 0;
    fauna.stepX[slot] = ints[at + 6] ?? 0;
    fauna.stepY[slot] = ints[at + 7] ?? 0;
    fauna.depart[slot] = ints[at + 8] ?? NO;
    fauna.hunter[slot] = (ints[at + 9] ?? 0) >>> 0;
    fauna.sex[slot] = sex;
    fauna.gait[slot] = gait;
    fauna.stepDays[slot] = days[slot] ?? 0;
    if (!inside(fauna.x[slot] ?? 0, fauna.y[slot] ?? 0)) return fail('position hors du monde');
    if (!inside(fauna.placeX[slot] ?? 0, fauna.placeY[slot] ?? 0))
      return fail('place hors du monde');
    const left = fauna.stepDays[slot] ?? 0;
    const sx = fauna.stepX[slot] ?? 0;
    const sy = fauna.stepY[slot] ?? 0;
    if (left > MAX_LEG_DAYS || Math.abs(sx) > MAX_STEP || Math.abs(sy) > MAX_STEP)
      return fail('étape illisible');
    if (left === 0 && (sx !== 0 || sy !== 0)) return fail('étape illisible');
    const endY = (fauna.y[slot] ?? 0) + left * sy;
    if (endY < 0 || endY >= tall) return fail('étape hors du monde');
  }
  const seen = new Uint8Array(Math.max(n, h));
  for (const slot of free) {
    if (slot < 0 || slot >= n || fauna.alive[slot] === 1 || seen[slot] === 1)
      return fail('pile libre des animaux');
    seen[slot] = 1;
    fauna.free.push(slot);
  }
  seen.fill(0);
  for (const herd of herdFree) {
    if (herd < 0 || herd >= h || fauna.herdAlive[herd] === 1 || seen[herd] === 1)
      return fail('pile libre des hardes');
    seen[herd] = 1;
    fauna.herdFree.push(herd);
  }
  // Chaque emplacement est vivant ou libre, sans quoi il ne servirait plus jamais.
  if (fauna.count + fauna.free.length !== n) return fail('emplacements perdus');
  if (fauna.herdCount + fauna.herdFree.length !== h) return fail('emplacements de hardes perdus');
  rebuildFauna(fauna);
  return fauna;
}
