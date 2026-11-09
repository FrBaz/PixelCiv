import { Application, TextureSource } from 'pixi.js';

/** Couleur de fond de la carte, assortie à la page. */
export const BACKGROUND = '#14120f';

/**
 * Crée le rendu PixiJS dans `container`, qu'il suit dans ses changements de taille
 * (fenêtre, orientation). Pixel art : échantillonnage au plus proche, sans lissage,
 * positions arrondies au pixel, à la densité de pixels de l'écran.
 */
export async function createRenderer(container: HTMLElement): Promise<Application> {
  TextureSource.defaultOptions.scaleMode = 'nearest';
  const app = new Application();
  await app.init({
    resizeTo: container,
    background: BACKGROUND,
    antialias: false,
    autoDensity: true,
    resolution: window.devicePixelRatio,
    roundPixels: true,
    preference: 'webgl',
  });
  container.appendChild(app.canvas);
  return app;
}
