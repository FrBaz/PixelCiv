/**
 * Point d'entrée du worker de simulation : branche l'hôte sur la messagerie,
 * l'horloge et les minuteries du worker, le contenu du jeu et le générateur de mondes.
 */
import { loadGameData } from '../core/data';
import type { MainMessage } from '../core/protocol';
import { generateWorld } from '../worldgen/generate';
import { SimulationHost } from './host';

// Le contenu est validé au chargement du worker, comme sur le fil principal.
const data = loadGameData();

const host = new SimulationHost(
  {
    post: (message, transfer) => {
      self.postMessage(message, transfer);
    },
    now: () => performance.now(),
    setTimer: (callback, delay) => self.setTimeout(callback, delay),
    clearTimer: (handle) => {
      self.clearTimeout(handle);
    },
  },
  data,
  (params, onStage) => generateWorld(params, data, onStage),
);

self.addEventListener('message', (event: MessageEvent<MainMessage>) => {
  host.receive(event.data);
});
