// Point d'entrée de l'application : crée le rendu de la carte, l'interface et le worker
// de simulation, puis les relie.
import { h, render } from 'preact';
import { loadGameData } from '../core/data';
import { PROTOCOL_VERSION } from '../core/protocol';
import { t } from '../i18n';
import { CameraControls } from '../render/controls';
import { cellAt, MapView } from '../render/map';
import { createRenderer } from '../render/renderer';
import { App } from '../ui/App';
import { content, stats, time } from '../ui/store';
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
  const mapElement = element('map');
  const app = await createRenderer(mapElement);
  const map = new MapView(app);
  const simulation = new SimulationClient();
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
  app.ticker.add((ticker) => {
    map.draw(controls.update(ticker.deltaMS));
  });

  simulation.subscribe((message) => {
    switch (message.type) {
      case 'ready':
        simulation.send({ type: 'newGame', seed: 'pixelciv', size: 'small' });
        break;
      case 'snapshot': {
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
        stats.value = message.stats;
        break;
      case 'error':
        console.error(`worker : ${message.code} (${message.detail})`);
        break;
    }
  });
  render(h(App, { actions: simulation }), element('ui'));

  // Débogage : ?stepCost=200 ajoute un coût factice de 200 ms à chaque pas.
  const stepCost = Number(new URLSearchParams(location.search).get('stepCost') ?? 0);
  if (stepCost > 0) simulation.send({ type: 'debugStepCost', milliseconds: stepCost });
  simulation.send({ type: 'hello', protocol: PROTOCOL_VERSION });
}

void main();
