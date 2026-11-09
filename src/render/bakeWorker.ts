/**
 * Worker de cuisson (tâche 1.7 ; ADR 0010) : il reçoit les couches du monde, puis cuit
 * les blocs qu'on lui demande et renvoie leurs pixels, transférés. Il ne connaît ni
 * PixiJS ni le DOM.
 */
import { bakeChunk, type BakeWorld } from './bake';
import type { BakeReply, BakeRequest } from './bakeProtocol';
import { CHUNK_SIZE } from '../core/world';

let world: BakeWorld | undefined;
let generation = -1;

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
        river: message.river,
      };
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
          },
          [],
        );
        break;
      }
      const pixels = bakeChunk(world, message.column, message.row);
      reply({ type: 'baked', generation, column: message.column, row: message.row, pixels }, [
        pixels.buffer,
      ]);
      break;
    }
  }
});
