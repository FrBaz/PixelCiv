// Captures du contrôle des pixels des humains (ADR 0016, § 9 ; LISEZMOI.md).
//
// node tools/human-control/capture.cjs <adresse> <dossier>
//
// Pour chaque vue de VIEWS : un monde Petit et une foule de débogage (?crowd=), sur PC
// (1 280 × 720, densité 1) ou sur Pixel 5 (densité 2,75), au zoom d'ouverture voulu. La partie
// avance quelques secondes, pour que des individus marchent et se retournent, puis se met en
// pause. La page rend alors la scène et lit le tampon WebGL ; elle range, pour chaque particule
// des humains, dans l'ordre du dessin, son cadre dans l'atlas des rôles, sa place, son échelle
// et la place de sa palette (sa couleur), puis la texture des palettes telle que le CPU l'a
// écrite. Chaque vue écrit meta.json, frame.rgba et palettes.rgba dans <dossier>/<nom>/, que
// pixels.control.ts compare ensuite à l'atlas des rôles du build et à cette texture.
// CONTROL_VIEWS=pc-z8,pixel5-z4 n'en capture que certaines.
//
// Un navigateur par vue, fermé aussitôt : une capture sur Pixel 5 tient une dizaine de mégaoctets.
//
// Playwright n'est pas une dépendance du projet : le script le prend là où Node le trouve
// (installation globale).
//
// Un script CommonJS, hors des programmes TypeScript : Node lui fournit require, process et
// console, URL et Buffer ; la page, window, Worker et btoa.
/* global require, process, console, setTimeout, window, Worker, btoa, URL, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports -- un script CommonJS lancé par Node */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

/**
 * Les vues : chaque niveau de motifs (facteurs 3, 1,5 et la planche), k = 1 et k = 2, les deux
 * densités d'écran, et des foules de plus de 256 apparences, qui font doubler deux fois la
 * texture des palettes et portent les places au-delà de 255.
 */
const VIEWS = [
  { name: 'pc-z8', seed: 'pixelciv', device: 'pc', zoom: 8, crowd: 4000 },
  { name: 'pc-z4', seed: 'graine', device: 'pc', zoom: 4, crowd: 2000 },
  { name: 'pc-z24', seed: 'pixelciv', device: 'pc', zoom: 24, crowd: 600 },
  { name: 'pixel5-z4', seed: 'pixelciv', device: 'pixel5', zoom: 4, crowd: 2000 },
  { name: 'pixel5-z8', seed: 'pixelciv', device: 'pixel5', zoom: 8, crowd: 600 },
];
const DEVICES = {
  pc: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  pixel5: devices['Pixel 5'],
};
/** Durée de la partie qui avance avant la pause, en millisecondes. */
const RUN_MS = 4000;

const [address, out] = process.argv.slice(2);
if (address === undefined || out === undefined) {
  console.error('node capture.cjs <adresse> <dossier>');
  process.exit(2);
}
const only = (process.env.CONTROL_VIEWS ?? '').split(',').filter((name) => name !== '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Avant le chargement : garde l'application PixiJS, met la partie en pause dès sa création. */
function init() {
  globalThis.__PIXI_APP_INIT__ = function (app) {
    if (window.__app === undefined) window.__app = app ?? this;
  };
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...rest) {
    if (message !== null && typeof message === 'object' && message.type === 'newGame') {
      post.call(this, { type: 'setPaused', paused: true });
    }
    return post.call(this, message, ...rest);
  };
}

/** Attend que tous les blocs de la carte soient cuits, au panneau de débogage (F3). */
async function baked(page) {
  await page.keyboard.press('F3');
  await page.getByText('0 bloc à cuire', { exact: true }).waitFor({ timeout: 180_000 });
  await page.keyboard.press('F3');
  await page
    .getByText('0 bloc à cuire', { exact: true })
    .waitFor({ state: 'detached', timeout: 10_000 });
}

async function click(page, label) {
  const button = page.locator(`button[aria-label="${label}"]`);
  if ((await button.count()) > 0) await button.first().click();
}

/** Dans la page : rend la scène, lit le tampon, et range particules et palettes. */
function dump() {
  const app = window.__app;
  const find = (node) => {
    for (const child of node.children ?? []) {
      if (child.particleChildren !== undefined) return child;
      const found = find(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const humans = find(app.stage);
  if (humans === undefined) return { error: 'aucun conteneur de particules' };
  const shader = humans.shader;
  const palettes = shader?.resources?.uPalettes;
  const roles = humans.particleChildren[0]?.texture?.source;
  if (palettes === undefined || roles === undefined) return { error: 'aucun shader des humains' };
  app.render();
  const gl = app.renderer.gl;
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const read = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, read);
  // Le tampon se lit de bas en haut : l'image se range de haut en bas.
  const frame = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    frame.set(read.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
  }
  const base64 = (bytes) => {
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(text);
  };
  const particles = humans.particleChildren.map((particle) => {
    const box = particle.texture.frame;
    return [
      box.x,
      box.y,
      box.width,
      box.height,
      particle.x,
      particle.y,
      particle.scaleX,
      particle.scaleY,
      particle.color >>> 0,
    ];
  });
  return {
    // PixiJS nomme le programme dans sa source : #define SHADER_NAME <nom>-fragment.
    shader: (/#define SHADER_NAME (\S+)/.exec(shader.glProgram?.fragment ?? '') ?? [])[1] ?? '',
    width,
    height,
    resolution: app.renderer.resolution,
    rows: shader.resources.humans.uniforms.uPaletteRows,
    paletteWidth: palettes.width,
    paletteHeight: palettes.height,
    atlasWidth: roles.width,
    atlasHeight: roles.height,
    particles,
    frame: base64(frame),
    palettes: base64(palettes.resource),
  };
}

async function capture(view) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(DEVICES[view.device]);
    await context.addInitScript(init);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const query = `?seed=${view.seed}&size=small&zoom=${String(view.zoom)}&crowd=${String(view.crowd)}`;
    await page.goto(new URL(query, address).href);
    await page.waitForSelector('.time-date', { timeout: 180_000 });
    await page.waitForFunction(() => window.__app !== undefined, null, { timeout: 60_000 });
    await baked(page);
    await click(page, 'Reprendre');
    await sleep(RUN_MS);
    await click(page, 'Mettre en pause');
    await sleep(1000);
    const result = await page.evaluate(dump);
    if (result.error !== undefined) throw new Error(`${view.name} : ${result.error}`);
    const folder = path.join(out, view.name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'frame.rgba'), Buffer.from(result.frame, 'base64'));
    fs.writeFileSync(path.join(folder, 'palettes.rgba'), Buffer.from(result.palettes, 'base64'));
    const meta = { ...view, ...result, errors };
    delete meta.frame;
    delete meta.palettes;
    fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta));
    console.log(
      `${view.name} : ${String(result.particles.length)} particules, ${String(result.rows)} rangées de palettes, ${String(errors.length)} erreurs`,
    );
    await context.close();
  } finally {
    await browser.close();
  }
}

(async () => {
  for (const view of VIEWS) {
    if (only.length > 0 && !only.includes(view.name)) continue;
    await capture(view);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
