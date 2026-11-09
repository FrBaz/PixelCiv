import { Application, TextureSource, UPDATE_PRIORITY } from 'pixi.js';

/** Couleur de fond de la carte, assortie à la page. */
export const BACKGROUND = '#14120f';

/**
 * Crée le rendu PixiJS dans `container`, qu'il suit dans ses changements de taille
 * (fenêtre, orientation, zoom du navigateur). Pixel art : échantillonnage au plus
 * proche, sans lissage, positions arrondies au pixel, à la densité de pixels de l'écran.
 */
export async function createRenderer(container: HTMLElement): Promise<Application> {
  TextureSource.defaultOptions.scaleMode = 'nearest';
  const app = new Application();
  await app.init({
    width: container.clientWidth,
    height: container.clientHeight,
    background: BACKGROUND,
    antialias: false,
    autoDensity: true,
    resolution: window.devicePixelRatio,
    roundPixels: true,
    preference: 'webgl',
  });
  container.appendChild(app.canvas);
  followContainer(app, container);
  return app;
}

/**
 * Suit la taille du conteneur, en pixels CSS, et la densité de pixels de l'écran : le
 * canvas garde un pixel de rendu par pixel physique, sans que le navigateur ne l'étire
 * (CLAUDE.md, « Pixel art »). La comparaison se fait à chaque image, avant le dessin :
 * aucun événement ne signale tous les changements, et le zoom du navigateur change la
 * taille CSS et la densité à la fois, sans changer la taille en pixels physiques.
 * PixiJS ne réécrit la taille CSS du canvas que si sa taille en pixels change : elle
 * est donc écrite ici.
 */
function followContainer(app: Application, container: HTMLElement): void {
  let applied = { width: 0, height: 0, density: 0 };
  const follow = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const density = devicePixelRatio;
    if (width === applied.width && height === applied.height && density === applied.density) {
      return;
    }
    applied = { width, height, density };
    app.renderer.resize(width, height, density);
    app.canvas.style.width = `${String(width)}px`;
    app.canvas.style.height = `${String(height)}px`;
  };
  follow();
  app.ticker.add(follow, undefined, UPDATE_PRIORITY.HIGH);
}
