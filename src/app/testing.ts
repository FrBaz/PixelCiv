/**
 * Une partie avec le vrai hôte du worker, vue comme le fil principal la voit (tests de
 * l'horloge du rendu, des images et des étapes datées, ADR 0013, ADR 0014) : une image
 * toutes les FRAME_MS, et chaque message traité à l'instant de son envoi, comme dans
 * main.ts. Le worker peut avoir de l'avance sur l'image, occupé par un long pas mensuel :
 * ses messages attendent alors l'image de leur instant. Les tampons lus retournent à l'hôte,
 * comme le fait main.ts (message `recycle`).
 */
import { frameBuffers, legBuffers, PROTOCOL_VERSION, type WorkerMessage } from '../core/protocol';
import { CHUNK_SIZE, type WorldLayers } from '../core/world';
import { walkCost } from '../sim/terrain';
import { testData, testParams } from '../sim/testing';
import { SimulationHost } from '../worker/host';
import { FakeEnvironment, testGenerator } from '../worker/testing';
import { CrowdTimeline, type FrameQueue } from './frames';
import { GameClock } from './gameClock';

/** Durée d'une image à 60 images par seconde, en millisecondes. */
export const FRAME_MS = 1000 / 60;

export class HostedGame {
  readonly env = new FakeEnvironment();
  readonly host = new SimulationHost(this.env, testData, testGenerator);
  readonly clock = new GameClock();
  /** Couches du monde de l'instantané, que le pinceau change comme sur la carte. */
  layers: WorldLayers | undefined;
  /** La case se franchit-elle, d'après les couches reçues (walkCost) ? */
  readonly passable = (cell: number): boolean =>
    this.layers !== undefined && Number.isFinite(walkCost(this.layers, cell, testData));
  /** Colonnes du monde. */
  columns = 1;
  /** Tampons rendus à l'hôte, et lots d'étapes parmi eux. */
  recycled = 0;
  recycledLegs = 0;
  readonly crowd = new CrowdTimeline({
    carry: testData.species.entries[0]?.display.carry ?? 0,
    passable: this.passable,
    recycleFrame: (frame) => {
      this.recycle(frameBuffers(frame));
    },
    recycleLegs: (legs) => {
      this.recycledLegs++;
      this.recycle(legBuffers(legs));
    },
  });
  readonly frames: FrameQueue = this.crowd.frames;
  /** Instant de la dernière image, en millisecondes. */
  now = 0;
  /** Appelé après le traitement de chaque message, avec l'instant de son envoi. */
  onMessage: ((message: WorkerMessage, at: number) => void) | undefined;
  private delivered = 0;

  /** Poignée de main, puis une partie sur le monde Petit des tests. */
  async start(): Promise<void> {
    this.host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
    this.host.receive({ type: 'newGame', params: testParams() });
    await this.host.idle();
    this.deliver(this.env.time);
  }

  /** Traite les messages envoyés jusqu'ici, quel que soit leur instant (chargement). */
  flush(): void {
    this.deliver(Number.POSITIVE_INFINITY);
  }

  /**
   * L'image suivante, FRAME_MS plus tard : renvoie l'instant affiché, en jours, que montre
   * désormais le miroir des positions (crowd.shown).
   */
  frame(): number {
    this.now += FRAME_MS;
    if (this.env.time < this.now) this.env.advance(this.now - this.env.time);
    this.deliver(this.now);
    const shown = this.clock.advance(this.now);
    this.crowd.show(shown);
    return shown;
  }

  private recycle(buffers: ArrayBuffer[]): void {
    this.recycled += buffers.length;
    this.host.receive({ type: 'recycle', buffers });
  }

  private deliver(until: number): void {
    for (let entry = this.env.sent.at(this.delivered); entry !== undefined && entry.at <= until;) {
      this.delivered++;
      const { message, at } = entry;
      if (message.type === 'snapshot') {
        this.layers = message.layers;
        this.columns = message.world.size.width;
        this.crowd.reset(message.frame, message.time, message.world.size.width);
        this.clock.reset(message.time, at);
      } else if (message.type === 'delta') {
        // Les blocs repeints, comme sur la carte (render/map.ts, updateChunks).
        const layers = this.layers;
        for (const patch of layers === undefined ? [] : message.chunks) {
          for (let line = 0; line < CHUNK_SIZE; line++) {
            const start =
              (patch.row * CHUNK_SIZE + line) * this.columns + patch.column * CHUNK_SIZE;
            const row = patch.biome.subarray(line * CHUNK_SIZE, (line + 1) * CHUNK_SIZE);
            layers?.biome.set(row, start);
          }
        }
        this.crowd.receive(message.time, message.legs, message.frame);
        this.clock.receive(message.time, at);
      } else if (message.type === 'time') {
        this.clock.receive(message.time, at);
      } else if (message.type === 'stats' && message.stats.monthMs !== undefined) {
        this.clock.monthStep(message.stats.monthMs);
      }
      this.onMessage?.(message, at);
      entry = this.env.sent.at(this.delivered);
    }
  }
}
