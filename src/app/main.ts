// Point d'entrée de l'application : crée le rendu de la carte, l'interface et le worker
// de simulation.
import { h, render } from 'preact';
import { PROTOCOL_VERSION } from '../core/protocol';
import { t } from '../i18n';
import { createRenderer } from '../render/renderer';
import { App } from '../ui/App';
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
  render(h(App, null), element('ui'));

  const simulation = new SimulationClient();
  simulation.subscribe((message) => {
    if (message.type === 'ready')
      simulation.send({ type: 'newGame', seed: 'pixelciv', size: 'small' });
  });
  // Débogage : ?stepCost=200 ajoute un coût factice de 200 ms à chaque pas.
  const stepCost = Number(new URLSearchParams(location.search).get('stepCost') ?? 0);
  if (stepCost > 0) simulation.send({ type: 'debugStepCost', milliseconds: stepCost });
  simulation.send({ type: 'hello', protocol: PROTOCOL_VERSION });
}

void main();
