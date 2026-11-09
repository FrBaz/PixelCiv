// Point d'entrée de l'application : crée le rendu de la carte, l'interface et le worker
// de simulation, puis les relie.
import { h, render } from 'preact';
import { loadGameData } from '../core/data';
import { PROTOCOL_VERSION } from '../core/protocol';
import { determinismSelfTest } from '../core/selftest';
import { t } from '../i18n';
import { CameraControls } from '../render/controls';
import { cellAt, MapView } from '../render/map';
import { createRenderer } from '../render/renderer';
import { App } from '../ui/App';
import { content, debugInfo, determinismOk, time, worldInfo } from '../ui/store';
import { DebugSampler, usedMemoryMb } from './debug';
import { SaveManager, SaveStore } from './saves';
import { SimulationClient } from './simulation';
import './style.css';

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`élément #${id} introuvable`);
  return found;
}

async function main(): Promise<void> {
  document.title = t('app.title');
  // Le contenu est validé au démarrage : une donnée invalide lève ici une DataError.
  const data = loadGameData();
  content.value = { biomes: data.biomes.entries.length };
  // Auto-test du déterminisme : ce moteur redonne-t-il les empreintes de référence ?
  determinismOk.value = determinismSelfTest();
  const mapElement = element('map');
  const app = await createRenderer(mapElement);
  const map = new MapView(app);
  const simulation = new SimulationClient();
  // Sans IndexedDB (navigation privée, stockage refusé), le jeu tourne sans sauvegarde locale.
  const store = await SaveStore.open().catch(() => undefined);
  const saves = new SaveManager(simulation, store);
  const controls = new CameraControls({
    element: mapElement,
    viewport: () => map.viewport,
    world: () => map.world,
    onTap: (mapX, mapY) => {
      // Pinceau de test : peint la case touchée, par une commande de jeu.
      const cell = cellAt(mapX, mapY);
      simulation.send({ type: 'game', command: { type: 'paint', x: cell.x, y: cell.y, value: 8 } });
    },
  });
  const sampler = new DebugSampler();
  app.ticker.add((ticker) => {
    sampler.frame(ticker.deltaMS);
    map.draw(controls.update(ticker.deltaMS));
  });
  const renderer = { name: app.renderer.name, resolution: app.renderer.resolution };
  setInterval(() => {
    debugInfo.value = { ...sampler.sample(), memoryMb: usedMemoryMb(), renderer };
  }, 250);

  simulation.subscribe((message) => {
    switch (message.type) {
      case 'ready':
        // Reprend la dernière partie si elle a été sauvegardée, sinon en commence une.
        void saves
          .resume()
          .catch((error: unknown) => {
            console.error(error);
            return false;
          })
          .then((resumed) => {
            if (!resumed) simulation.send({ type: 'newGame', seed: 'pixelciv', size: 'small' });
            saves.startAutosave();
          });
        break;
      case 'snapshot': {
        worldInfo.value = message.world;
        map.setWorld(message.world, message.chunks);
        const world = map.world;
        if (world !== undefined) controls.center(world);
        time.value = message.time;
        break;
      }
      case 'delta':
        map.updateChunks(message.chunks);
        time.value = message.time;
        break;
      case 'time':
        time.value = message.time;
        break;
      case 'stats':
        sampler.step(message.stats.stepMs);
        break;
      case 'error':
        console.error(`worker : ${message.code} (${message.detail})`);
        break;
      case 'saved':
      case 'saveFailed':
      case 'loaded':
      case 'loadFailed':
        // Réponses aux requêtes de SaveManager, qui les attend.
        break;
    }
  });
  const actions = {
    send: (message: Parameters<SimulationClient['send']>[0]) => {
      simulation.send(message);
    },
    save: () => saves.save(),
    load: () => saves.load(),
    exportFile: () => saves.exportFile(),
    importFile: (file: File) => saves.importFile(file),
  };
  render(h(App, { actions }), element('ui'));

  // Débogage : ?stepCost=200 ajoute un coût factice de 200 ms à chaque pas.
  const stepCost = Number(new URLSearchParams(location.search).get('stepCost') ?? 0);
  if (stepCost > 0) simulation.send({ type: 'debugStepCost', milliseconds: stepCost });
  simulation.send({ type: 'hello', protocol: PROTOCOL_VERSION });
}

void main();
