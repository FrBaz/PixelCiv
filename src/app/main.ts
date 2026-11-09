// Point d'entrée de l'application : crée le rendu de la carte, l'interface et le worker
// de simulation, puis les relie.
import { h, render } from 'preact';
import { PROTOCOL_VERSION } from '../core/protocol';
import { t } from '../i18n';
import { createRenderer } from '../render/renderer';
import { App } from '../ui/App';
import { stats, time } from '../ui/store';
import { SimulationClient } from './simulation';
import './style.css';

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`élément #${id} introuvable`);
  return found;
}

async function main(): Promise<void> {
  document.title = t('app.title');
  await createRenderer(element('map'));

  const simulation = new SimulationClient();
  simulation.subscribe((message) => {
    switch (message.type) {
      case 'ready':
        simulation.send({ type: 'newGame', seed: 'pixelciv', size: 'small' });
        break;
      case 'snapshot':
      case 'delta':
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
