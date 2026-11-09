/**
 * Point d'entrée du worker de simulation : branche l'hôte sur la messagerie,
 * l'horloge et les minuteries du worker.
 */
import type { MainMessage } from '../core/protocol';
import { SimulationHost } from './host';

const host = new SimulationHost({
  post: (message, transfer) => {
    self.postMessage(message, transfer);
  },
  now: () => performance.now(),
  setTimer: (callback, delay) => self.setTimeout(callback, delay),
  clearTimer: (handle) => {
    self.clearTimeout(handle);
  },
});

self.addEventListener('message', (event: MessageEvent<MainMessage>) => {
  host.receive(event.data);
});
