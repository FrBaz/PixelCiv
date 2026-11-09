import { Application, TextureSource, UPDATE_PRIORITY } from 'pixi.js';

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
  followPixelDensity(app, container);
  return app;
}

/**
 * Suit la densité de pixels de l'écran, qui change avec le zoom du navigateur ou d'un
 * écran à l'autre : le canvas garde un pixel de rendu par pixel physique, sans que le
 * navigateur ne l'étire (CLAUDE.md, « Pixel art »). La comparaison se fait à chaque
 * image, avant le dessin : aucun événement ne signale tous les changements.
 */
function followPixelDensity(app: Application, container: HTMLElement): void {
  app.ticker.add(
    () => {
      if (devicePixelRatio !== app.renderer.resolution) {
        app.renderer.resize(container.clientWidth, container.clientHeight, devicePixelRatio);
      }
    },
    undefined,
    UPDATE_PRIORITY.HIGH,
  );
}
