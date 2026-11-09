/** Dimensions du monde et découpage en blocs de carte (ADR 0002). */

/** Côté d'un bloc de carte, en cases. */
export const CHUNK_SIZE = 64;

export interface WorldSize {
  readonly width: number;
  readonly height: number;
}

/** Tailles prédéfinies, au format 2:1 (MON-02). */
export const WORLD_SIZES = {
  small: { width: 512, height: 256 },
  medium: { width: 768, height: 384 },
  large: { width: 1024, height: 512 },
  huge: { width: 2048, height: 1024 },
} as const satisfies Record<string, WorldSize>;

export type WorldSizeId = keyof typeof WORLD_SIZES;

export interface ChunkGrid {
  readonly columns: number;
  readonly rows: number;
}

/** Nombre de blocs dans chaque direction ; les tailles sont des multiples de CHUNK_SIZE. */
export function chunkGrid(size: WorldSize): ChunkGrid {
  return { columns: size.width / CHUNK_SIZE, rows: size.height / CHUNK_SIZE };
}

/**
 * Couches du monde généré, une valeur par case, ligne par ligne (ADR 0009). La simulation
 * les possède, la sauvegarde les garde, et le rendu en reçoit une copie.
 */
export interface WorldLayers {
  /**
   * Altitude en mètres : au plus -1 en mer (fond marin) ; négative aussi au fond des lacs
   * sous le niveau de la mer ; au moins 0 sur les autres terres.
   */
  readonly elevation: Int16Array<ArrayBuffer>;
  /** Profondeur de l'eau en mètres : mer et lacs ; 0 ailleurs. */
  readonly waterDepth: Uint16Array<ArrayBuffer>;
  /** Biome naturel : indice dans data/biomes.json. */
  readonly biome: Uint8Array<ArrayBuffer>;
  /**
   * Écoulement : direction de la case aval sur les 4 bits faibles (0 à 7 depuis l'est,
   * dans le sens des aiguilles d'une montre ; 8 sans aval), classe de rivière sur les
   * 2 bits suivants (0 sans rivière, puis ruisseau, rivière, fleuve).
   */
  readonly drainage: Uint8Array<ArrayBuffer>;
  /** Température annuelle moyenne, en dixièmes de degré. */
  readonly temperature: Int16Array<ArrayBuffer>;
  /** Demi-amplitude saisonnière (C1, D8), en dixièmes de degré. */
  readonly amplitude: Uint8Array<ArrayBuffer>;
  /** Précipitations annuelles, en millimètres. */
  readonly precipitation: Uint16Array<ArrayBuffer>;
  /** Gisement : indice + 1 dans data/resources.json, 0 sans gisement. */
  readonly deposit: Uint8Array<ArrayBuffer>;
  /** Densités d'arbres et de buissons, de 0 à 255. */
  readonly trees: Uint8Array<ArrayBuffer>;
  readonly shrubs: Uint8Array<ArrayBuffer>;
}

/** Noms des couches, dans l'ordre : sauvegardes, transferts et empreintes les suivent. */
export const LAYER_NAMES = [
  'elevation',
  'waterDepth',
  'biome',
  'drainage',
  'temperature',
  'amplitude',
  'precipitation',
  'deposit',
  'trees',
  'shrubs',
] as const satisfies readonly (keyof WorldLayers)[];

/** Type de tableau de chaque couche. */
export const LAYER_TYPES = {
  elevation: Int16Array,
  waterDepth: Uint16Array,
  biome: Uint8Array,
  drainage: Uint8Array,
  temperature: Int16Array,
  amplitude: Uint8Array,
  precipitation: Uint16Array,
  deposit: Uint8Array,
  trees: Uint8Array,
  shrubs: Uint8Array,
} as const satisfies Record<keyof WorldLayers, unknown>;

/** Direction de l'écoulement codée dans `drainage` : 0 à 7, ou 8 sans case aval. */
export function flowDirection(drainage: number): number {
  return drainage & 0x0f;
}

/** Classe de rivière codée dans `drainage` : 0 sans rivière, 1 ruisseau, 2 rivière, 3 fleuve. */
export function riverClass(drainage: number): number {
  return (drainage >> 4) & 0x03;
}

/** Code d'écoulement d'une case. */
export function encodeDrainage(direction: number, river: number): number {
  return (direction & 0x0f) | ((river & 0x03) << 4);
}

/** Couches vides, pour un monde de la taille donnée. */
export function emptyLayers(size: WorldSize): WorldLayers {
  const count = size.width * size.height;
  return {
    elevation: new Int16Array(count),
    waterDepth: new Uint16Array(count),
    biome: new Uint8Array(count),
    drainage: new Uint8Array(count),
    temperature: new Int16Array(count),
    amplitude: new Uint8Array(count),
    precipitation: new Uint16Array(count),
    deposit: new Uint8Array(count),
    trees: new Uint8Array(count),
    shrubs: new Uint8Array(count),
  };
}

/** Copie de toutes les couches, dans des tampons neufs (transferts, sauvegardes). */
export function copyLayers(layers: WorldLayers): WorldLayers {
  return {
    elevation: layers.elevation.slice(),
    waterDepth: layers.waterDepth.slice(),
    biome: layers.biome.slice(),
    drainage: layers.drainage.slice(),
    temperature: layers.temperature.slice(),
    amplitude: layers.amplitude.slice(),
    precipitation: layers.precipitation.slice(),
    deposit: layers.deposit.slice(),
    trees: layers.trees.slice(),
    shrubs: layers.shrubs.slice(),
  };
}
