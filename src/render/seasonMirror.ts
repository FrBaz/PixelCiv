/**
 * Miroir des couleurs de la saison (tâche 2b.7 ; ADR 0019, § 2, 3 et 8) : ce que calcule le code
 * de src/render/seasonShader.ts pour un pixel de près, en flottants de 32 bits, comme le GPU en
 * précision haute. Les essais le comparent aux expressions du shader évaluées hors du GPU, et le
 * contrôle des pixels de Chromium (tools/season-control/) à l'écran : aucune couleur hors des
 * palettes déclarées, et, hors des saisons, la carte de ses tuiles.
 */
import { DRY_SCALE, FOLIAGE_UNIT, leafThreshold, type DryRule } from '../core/foliage';
import { warmestDay, YEAR_DAYS } from '../core/snow';
import { CHUNK_PX, IDENTITY, TINT, type Rgb } from './bake';
import { MEAN_COLUMN, STATE_COLUMNS } from './seasonShader';

const f32 = Math.fround;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Ce que le shader lit du monde : ses textures, telles que la carte les envoie. */
export interface SeasonTextures {
  /** Taille du monde, en cases. */
  readonly columns: number;
  readonly rows: number;
  /** Texture des saisons (src/render/seasons.ts, seasonTexels), quatre octets par case. */
  readonly data: Uint8Array;
  /** Calendrier de la végétation filtré (foliageTexels), quatre octets par case. */
  readonly foliage: Uint8Array;
  /** Tons des états (statePalettes), STATE_COLUMNS texels par biome. */
  readonly states: Uint8Array;
}

/**
 * Les uniformes des saisons : jour continu (uDay), facteur de saison du nord à ce jour (uSeason),
 * durée d'une transition, lumière d'hiver, rampe de la saison sèche (uDryShare, uDrySpan).
 */
export interface SeasonUniforms {
  readonly day: number;
  readonly season: number;
  readonly transition: number;
  readonly light: boolean;
  readonly dry: DryRule;
}

/**
 * L'état d'un point (seasonShader.ts, SEASON_EXPR.state) : −1 l'été, 0 automne, 1 nu, 2 sec, 3 hiver.
 * `south` : l'hémisphère du point, dont le signe du facteur de saison dépend.
 */
export function mirrorState(
  calendar: ArrayLike<number>,
  at: number,
  phase: number,
  threshold: number,
  uniforms: SeasonUniforms,
  south: boolean,
): number {
  const unit = f32(FOLIAGE_UNIT);
  const days = f32(uniforms.transition);
  const distance = Math.min(phase, f32(YEAR_DAYS - phase));
  const share = (date: number) =>
    date > 254.5 ? 0 : clamp01(f32(f32(f32(distance - f32(date * unit)) / days) + 0.5));
  const [autumnDate, bareDate, dryDate, lightDate] = [
    calendar[at],
    calendar[at + 1],
    calendar[at + 2],
    calendar[at + 3],
  ];
  const bare = share(bareDate);
  let autumn = 0;
  if (autumnDate < 254.5 && bareDate < 254.5) {
    const rise = f32(f32(f32(phase - f32(autumnDate * unit)) / days) + 0.5);
    const fall = f32(f32(f32(f32(YEAR_DAYS - f32(bareDate * unit)) - phase) / days) + 0.5);
    autumn = clamp01(Math.min(rise, fall));
  }
  const factor = f32(f32(uniforms.season) * (south ? -1 : 1));
  const dry =
    dryDate > 254.5
      ? 0
      : clamp01(
          f32(
            f32(f32(uniforms.dry.dryShare) - f32(1 + f32(f32(dryDate / DRY_SCALE) * factor))) /
              f32(uniforms.dry.drySpan),
          ),
        );
  const light = uniforms.light ? share(lightDate) : 0;
  if (threshold < bare) return 1;
  if (threshold < autumn) return 0;
  if (threshold < dry) return 2;
  if (threshold < light) return 3;
  return -1;
}

/** Le jour de phase (seasonShader.ts, SEASON_EXPR.leafPhase) du jour `day`, au sud ou non. */
export function mirrorPhase(day: number, south: boolean): number {
  const offset = f32(f32(day) - warmestDay(south));
  return f32(offset - f32(YEAR_DAYS * Math.floor(f32(offset / YEAR_DAYS))));
}

/**
 * La couleur de saison d'un pixel de terre de près, ou undefined s'il garde son ton cuit : le
 * pixel (x, y) d'un bloc d'origine (originX, originY) en cases, de texel cuit `texel` (RGBA) et de
 * code `code` dans la carte d'identité du bloc. `covered` : la neige ou la glace le couvre (la
 * couverture passe avant). Une rivière ou un ruisseau visible n'a pas d'état : l'appelant ne le
 * donne pas.
 */
export function seasonPixel(
  textures: SeasonTextures,
  uniforms: SeasonUniforms,
  originX: number,
  originY: number,
  x: number,
  y: number,
  texel: ArrayLike<number>,
  code: number,
  covered: boolean,
): Rgb | undefined {
  if (covered || code === IDENTITY.none || (texel[0] & 1) === 0) return undefined;
  const { columns, rows } = textures;
  const wx = originX * 4 + x;
  const wy = originY * 4 + y;
  const rank = (code - 1) % IDENTITY.ranks;
  const lender = Math.floor((code - 1) / IDENTITY.ranks);
  const cornerX = Math.floor((wx + 0.5) / 4 - 0.5);
  const cornerY = Math.floor((wy + 0.5) / 4 - 0.5);
  const sourceX = (((cornerX + (lender % 2)) % columns) + columns) % columns;
  const sourceY = Math.min(rows - 1, Math.max(0, cornerY + Math.floor(lender / 2)));
  const cell = (sourceY * columns + sourceX) * 4;
  const south = ((textures.data[cell + 2] ?? 0) & 1) === 1;
  const phase = mirrorPhase(uniforms.day, south);
  const state = mirrorState(textures.foliage, cell, phase, leafThreshold(wx, wy), uniforms, south);
  if (state < 0) return undefined;
  const biome = textures.data[cell + 3] ?? 0;
  const tone = (biome * STATE_COLUMNS + state * 3 + rank) * 4;
  const shade = f32(f32(texel[3] / 255) + 0.5);
  const temperature = f32(f32((textures.data[cell] ?? 0) / 2) - 64);
  const warm = clamp01(f32(f32(temperature - TINT.warmFrom) / TINT.warmSpan));
  const cold = clamp01(f32(f32(-temperature) / TINT.coldSpan));
  const tint = [
    f32(f32(1 + f32(f32(TINT.red) * warm)) - f32(f32(TINT.red) * cold)),
    f32(1 + f32(f32(TINT.green) * warm)),
    f32(f32(1 - f32(f32(TINT.blue) * warm)) + f32(f32(TINT.blue) * cold)),
  ];
  const channel = (index: number) => {
    const value = f32(
      f32(f32((textures.states[tone + index] ?? 0) / 255) * shade) * (tint[index] ?? 1),
    );
    return Math.min(255, Math.max(0, Math.round(value * 255)));
  };
  return [channel(0), channel(1), channel(2)];
}

/**
 * La couleur de saison d'un pixel de terre de loin (une échelle sous 1 : seasonShader.ts, la
 * branche de loin), ou undefined s'il garde son texel : le pixel (x, y) d'un bloc d'origine
 * (originX, originY) en cases, de texel `texel` (RGBA, celui du niveau de mipmap que lit le GPU) et
 * de carte d'identité `identity` (le code du pixel (x, y) du bloc ; un tableau de CHUNK_PX de côté,
 * ou une fonction). La case du pixel décide à son seuil ; elle ne prend la saison que si ses seize
 * pixels portent un ton de terre, et son texel prend alors le rapport des tons moyens de l'état
 * et de l'été de son biome.
 */
export function seasonFarPixel(
  textures: SeasonTextures,
  uniforms: SeasonUniforms,
  originX: number,
  originY: number,
  x: number,
  y: number,
  texel: ArrayLike<number>,
  identity: ArrayLike<number> | ((x: number, y: number) => number),
  covered: boolean,
): Rgb | undefined {
  const codeAt =
    typeof identity === 'function'
      ? identity
      : (px: number, py: number) => identity[py * CHUNK_PX + px] ?? IDENTITY.none;
  if (covered) return undefined;
  const cx = originX + Math.floor(x / 4);
  const cy = originY + Math.floor(y / 4);
  const cell = (cy * textures.columns + cx) * 4;
  const flags = textures.data[cell + 2] ?? 0;
  // De loin, une case d'eau (bit 64) est de l'eau, quelle que soit sa couleur.
  if ((flags & 64) !== 0) return undefined;
  const left = x - (x % 4);
  const top = y - (y % 4);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      if (codeAt(left + i, top + j) === IDENTITY.none) {
        return undefined;
      }
    }
  }
  const south = (flags & 1) === 1;
  const state = mirrorState(
    textures.foliage,
    cell,
    mirrorPhase(uniforms.day, south),
    leafThreshold(cx, cy),
    uniforms,
    south,
  );
  if (state < 0) return undefined;
  const row = (textures.data[cell + 3] ?? 0) * STATE_COLUMNS;
  const mean = (row + MEAN_COLUMN + 1 + state) * 4;
  const summer = (row + MEAN_COLUMN) * 4;
  const channel = (index: number) => {
    const tone = f32(
      f32(f32((texel[index] ?? 0) / 255) * f32((textures.states[mean + index] ?? 0) / 255)) /
        Math.max(f32((textures.states[summer + index] ?? 0) / 255), f32(1 / 255)),
    );
    return Math.min(255, Math.max(0, Math.round(tone * 255)));
  };
  return [channel(0), channel(1), channel(2)];
}
