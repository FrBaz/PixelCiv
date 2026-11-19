/**
 * Worker de cuisson (tâche 1.7 ; ADR 0010) : il reçoit les couches du monde, puis cuit
 * les blocs qu'on lui demande et renvoie leurs pixels, transférés, avec le masque de leur mer
 * animée (tâche 2b.4, ADR 0015 ; bakedReply). Il ne connaît ni PixiJS ni le DOM.
 */
import { bakeChunk, type BakeWorld } from './bake';
import { bakedReply, type BakeReply, type BakeRequest } from './bakeProtocol';
import { CHUNK_SIZE } from '../core/world';

let world: BakeWorld | undefined;
let generation = -1;
/** Tons cuits de la mer animée, cherchés dans chaque bloc cuit. */
let seaTones: readonly number[] = [];

function reply(message: BakeReply, transfer: Transferable[]): void {
  self.postMessage(message, { transfer });
}

self.addEventListener('message', (event: MessageEvent<BakeRequest>) => {
  const message = event.data;
  switch (message.type) {
    case 'world':
      generation = message.generation;
      world = {
        size: message.size,
        layers: message.layers,
        biomes: message.biomes,
        riverBiome: message.riverBiome,
      };
      seaTones = message.seaTones;
      break;
    case 'patch': {
      if (world === undefined || message.generation !== generation) break;
      const { width } = world.size;
      for (let line = 0; line < CHUNK_SIZE; line++) {
        const start = (message.row * CHUNK_SIZE + line) * width + message.column * CHUNK_SIZE;
        world.layers.biome.set(
          message.biome.subarray(line * CHUNK_SIZE, (line + 1) * CHUNK_SIZE),
          start,
        );
      }
      break;
    }
    case 'bake': {
      // Une demande d'un monde remplacé depuis n'a plus d'objet.
      if (world === undefined || message.generation !== generation) {
        reply(
          {
            type: 'skipped',
            generation: message.generation,
            column: message.column,
            row: message.row,
            version: message.version,
          },
          [],
        );
        break;
      }
      const baked = bakedReply(
        message,
        generation,
        bakeChunk(world, message.column, message.row),
        seaTones,
      );
      reply(baked.reply, baked.transfer);
      break;
    }
  }
});
