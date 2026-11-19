/**
 * Messages entre le fil principal et les workers de cuisson (ADR 0010). Chaque monde a
 * son numéro de génération : une réponse d'un monde remplacé est ignorée.
 */
import type { WorldLayers, WorldSize } from '../core/world';
import { CHUNK_PX, type BakeBiome } from './bake';
import { seaMask } from './waves';

export type BakeRequest =
  /**
   * Nouveau monde : ses couches, copiées pour le worker, les palettes, et les tons cuits de
   * la mer animée (src/render/waves.ts), que le worker cherche dans chaque bloc cuit.
   */
  | {
      readonly type: 'world';
      readonly generation: number;
      readonly size: WorldSize;
      readonly layers: WorldLayers;
      readonly biomes: readonly BakeBiome[];
      readonly riverBiome: number;
      readonly seaTones: readonly number[];
    }
  /** Biome d'un bloc changé par la simulation. */
  | {
      readonly type: 'patch';
      readonly generation: number;
      readonly column: number;
      readonly row: number;
      readonly biome: Uint8Array<ArrayBuffer>;
    }
  /** Cuisson d'un bloc, dans sa version courante. */
  | {
      readonly type: 'bake';
      readonly generation: number;
      readonly column: number;
      readonly row: number;
      readonly version: number;
    };

export type BakeReply =
  | {
      readonly type: 'baked';
      readonly generation: number;
      readonly column: number;
      readonly row: number;
      readonly version: number;
      readonly pixels: Uint8Array<ArrayBuffer>;
      /**
       * Masque de la mer animée du bloc (src/render/waves.ts, seaMask) : un octet par tuile. La
       * carte ne dessine avec l'onde qu'un bloc dont la partie visible touche une tuile de mer.
       */
      readonly seaMask: Uint8Array<ArrayBuffer>;
    }
  /** Demande devenue sans objet : le monde a changé entre-temps. */
  | {
      readonly type: 'skipped';
      readonly generation: number;
      readonly column: number;
      readonly row: number;
      readonly version: number;
    };

/**
 * La réponse du worker à la cuisson `request` du monde `generation` : les pixels cuits, et le
 * masque de la mer animée aux tons `seaTones`, tous deux transférés (`transfer`).
 */
export function bakedReply(
  request: Extract<BakeRequest, { type: 'bake' }>,
  generation: number,
  pixels: Uint8Array<ArrayBuffer>,
  seaTones: readonly number[],
): { readonly reply: BakeReply; readonly transfer: Transferable[] } {
  const mask = seaMask(pixels, seaTones, CHUNK_PX);
  return {
    reply: {
      type: 'baked',
      generation,
      column: request.column,
      row: request.row,
      version: request.version,
      pixels,
      seaMask: mask,
    },
    transfer: [pixels.buffer, mask.buffer],
  };
}
