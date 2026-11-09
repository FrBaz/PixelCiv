// Point d'entrée de l'application : crée le rendu de la carte et l'interface.
import { h, render } from 'preact';
import { t } from '../i18n';
import { createRenderer } from '../render/renderer';
import { App } from '../ui/App';
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
}

void main();
