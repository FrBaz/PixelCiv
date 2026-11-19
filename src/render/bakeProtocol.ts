/**
 * Messages entre le fil principal et les workers de cuisson (ADR 0010). Chaque monde a
 * son numéro de génération : une réponse d'un monde remplacé est ignorée.
 */
import type { WorldLayers, WorldSize } from '../core/world';
import type { BakeBiome } from './bake';

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
      /** Le bloc a-t-il un pixel de mer animée ? Sinon, la carte le dessine sans l'onde. */
      readonly sea: boolean;
    }
  /** Demande devenue sans objet : le monde a changé entre-temps. */
  | {
      readonly type: 'skipped';
      readonly generation: number;
      readonly column: number;
      readonly row: number;
      readonly version: number;
    };
