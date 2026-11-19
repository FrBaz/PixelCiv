// Captures du contrôle des pixels de la mer animée (ADR 0015, § 10 ; LISEZMOI.md).
//
// node tools/wave-control/capture.cjs <adresse> <dossier> [adresse de 2b.3]
//
// Pour chaque vue de VIEWS : un monde Petit, sur PC (1 280 × 720, densité 1), au zoom 1, au
// mois forcé par ?month= ; la partie en pause dès sa création ; la carte amenée au point voulu
// par des glissés de souris ; l'interface masquée. Une capture au repos, l'onde éteinte par le
// mouvement réduit émulé, puis STEPS pas successifs de l'onde, menés par l'horloge de
// Playwright, chacun avec la phase que montrent les uniformes du shader. Avec l'adresse d'une
// construction de 2b.3, une capture de celle-ci au même endroit, pour les vues du mois 0.
// Chaque vue écrit ses PNG et son meta.json dans <dossier>/<graine>-m<mois>/, que
// pixels.control.ts compare ensuite au miroir du shader. CONTROL_VIEWS=pixelciv-m0,autre-m3.2
// n'en capture que certaines.
//
// Playwright n'est pas une dépendance du projet : le script le prend là où Node le trouve
// (installation globale).
//
// Un script CommonJS, hors des programmes TypeScript : Node lui fournit require, process et
// console ; la page, window, Worker et requestAnimationFrame.
/* global require, process, console, setTimeout, window, Worker, requestAnimationFrame */
/* eslint-disable @typescript-eslint/no-require-imports -- un script CommonJS lancé par Node */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

/** Les vues du contrôle : trois graines, des mois de gel partiel, la couture. */
const VIEWS = [
  { seed: 'pixelciv', x: 40, y: 500, month: 0 },
  { seed: 'pixelciv', x: 32, y: 360, month: 1.3 },
  { seed: 'graine', x: 2030, y: 500, month: 0 },
  { seed: 'graine', x: 1856, y: 620, month: 11.4 },
  { seed: 'autre', x: 20, y: 520, month: 0 },
  { seed: 'autre', x: 1888, y: 360, month: 3.2 },
];
const STEPS = 8;
const STEP_MS = 250;
/** Largeur d'un monde Petit, en pixels de carte : la couture. */
const SPAN = 2048;
const PC = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };
const HIDE_UI = '#ui { visibility: hidden !important; }';

const [address, out, baseAddress] = process.argv.slice(2);
if (address === undefined || out === undefined) {
  console.error('node capture.cjs <adresse> <dossier> [adresse de 2b.3]');
  process.exit(2);
}
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
  await page.getByText('0 bloc à cuire', { exact: true }).waitFor({ timeout: 120_000 });
  await page.keyboard.press('F3');
  await page
    .getByText('0 bloc à cuire', { exact: true })
    .waitFor({ state: 'detached', timeout: 10_000 });
}

/** Centre de l'écran en pixels de carte, et taille de l'écran, lus sur les blocs dessinés. */
async function camera(page) {
  return page.evaluate((span) => {
    const app = window.__app;
    const res = app.renderer.resolution;
    const vw = Math.round(app.screen.width * res);
    const vh = Math.round(app.screen.height * res);
    const meshes = [];
    const walk = (node) => {
      for (const child of node.children ?? []) {
        const origin = child.shader?.resources?.origin?.uniforms?.uOrigin;
        if (child.visible && origin !== undefined) {
          meshes.push({
            column: origin[0] / 64,
            row: origin[1] / 64,
            left: child.position.x * res,
            top: child.position.y * res,
            width: child.scale.x * res * 256,
          });
        }
        walk(child);
      }
    };
    walk(app.stage);
    if (meshes.length === 0) return { vw, vh, meshes: 0 };
    const scale = meshes[0].width / 256;
    const first = meshes[0];
    let x = first.column * 256 + (vw / 2 - first.left) / scale;
    x = ((x % span) + span) % span;
    const y = first.row * 256 + (vh / 2 - first.top) / scale;
    return {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      scale,
      vw,
      vh,
      meshes: meshes.length,
    };
  }, SPAN);
}

/** Quelques images, pour que l'écran montre l'état demandé. */
async function frames(page, count = 3) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let k = 0;
        const next = () => (++k >= n ? resolve() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    count,
  );
}

/** Amène le point (x, y), en pixels de carte, au centre de l'écran, par des glissés de souris. */
async function panTo(page, x, y) {
  const viewport = page.viewportSize();
  for (let round = 0; round < 14; round++) {
    await sleep(300);
    const cam = await camera(page);
    if (cam.meshes === 0) continue;
    const dx = ((((x - cam.x + SPAN / 2) % SPAN) + SPAN) % SPAN) - SPAN / 2;
    const sx = dx * cam.scale;
    const sy = (y - cam.y) * cam.scale;
    if (Math.abs(sx) < 0.5 && Math.abs(sy) < 0.5) return cam;
    // Le pointeur va à l'opposé de la caméra : la carte suit la souris.
    const k = Math.min(
      1,
      (viewport.width * 0.6) / Math.max(1e-9, Math.abs(sx)),
      (viewport.height * 0.45) / Math.max(1e-9, Math.abs(sy)),
    );
    const [mx, my] = [-sx * k, -sy * k];
    const from = { x: viewport.width / 2 - mx / 2, y: viewport.height / 2 - my / 2 + 20 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Un court glissé commence par un écart franc, pour ne pas passer pour un clic.
    const path = [];
    if (Math.hypot(mx, my) < 16) {
      for (let s = 1; s <= 8; s++) path.push({ x: (24 * s) / 8, y: 0 });
      for (let s = 1; s <= 8; s++) path.push({ x: 24 + ((mx - 24) * s) / 8, y: (my * s) / 8 });
    } else {
      for (let s = 1; s <= 16; s++) path.push({ x: (mx * s) / 16, y: (my * s) / 16 });
    }
    for (const point of path) {
      await page.mouse.move(from.x + point.x, from.y + point.y);
      await sleep(25);
    }
    await sleep(150);
    await page.mouse.up();
  }
  throw new Error(`la carte n'atteint pas (${String(x)}, ${String(y)})`);
}

/** Phase de l'onde que montrent les uniformes du premier bloc dessiné par son programme. */
async function phaseShown(page) {
  return page.evaluate(() => {
    const found = [];
    const walk = (node) => {
      for (const child of node.children ?? []) {
        const waves = child.shader?.resources?.waves?.uniforms;
        if (child.visible && waves !== undefined) found.push(Array.from(waves.uWavePhase));
        walk(child);
      }
    };
    walk(window.__app.stage);
    return found[0];
  });
}

/** Ouvre une construction sur un monde Petit, au zoom 1 ; rend la page, ses journaux. */
async function open(context, url, view, extra) {
  await context.addInitScript(init);
  const page = await context.newPage();
  const logs = [];
  page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
  await page.goto(`${url}?seed=${encodeURIComponent(view.seed)}&size=small&zoom=1${extra}`);
  await page.waitForSelector('.time-date', { timeout: 180_000 });
  await page.waitForFunction(() => window.__app !== undefined, null, { timeout: 60_000 });
  await baked(page);
  const cam = await panTo(page, view.x, view.y);
  await page.addStyleTag({ content: HIDE_UI });
  return { page, logs, cam };
}

/** Journaux inattendus ; SwiftShader se plaint des lectures de pixels des captures. */
const badLogs = (logs) =>
  logs.filter(
    (line) =>
      /^\[(error|warning|pageerror)\]/.test(line) && !/GPU stall due to ReadPixels/.test(line),
  );

async function captureView(view) {
  const folder = path.join(out, viewName(view));
  fs.mkdirSync(folder, { recursive: true });
  const started = Date.now();
  const meta = { seed: view.seed, month: view.month, steps: [] };
  const logs = [];
  // Un navigateur par vue, fermé aussitôt : la mémoire du conteneur est comptée.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(PC);
    await context.clock.install();
    const opened = await open(context, address, view, `&month=${String(view.month)}`);
    const { page } = opened;
    meta.cam = opened.cam;
    // Le repos : l'onde éteinte par le mouvement réduit, l'image de la carte sans elle.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await sleep(300);
    await frames(page);
    await page.screenshot({ path: path.join(folder, 'rest.png') });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await sleep(300);
    // L'horloge de la page s'arrête : chaque runFor avance l'onde d'un pas, et l'image suit.
    await page.clock.pauseAt(Date.now() + 60_000);
    for (let step = 0; step < STEPS; step++) {
      await page.clock.runFor(STEP_MS);
      const file = `s${String(step).padStart(2, '0')}.png`;
      meta.steps.push({ phase: await phaseShown(page), file });
      await page.screenshot({ path: path.join(folder, file) });
    }
    logs.push(...opened.logs);
    await context.close();
    if (baseAddress !== undefined && view.month === 0) {
      // 2b.3 ne connaît pas ?month : la partie y commence en janvier, au mois 0.
      const baseContext = await browser.newContext(PC);
      const base = await open(baseContext, baseAddress, view, '');
      await frames(base.page);
      await base.page.screenshot({ path: path.join(folder, 'base.png') });
      meta.base = 'base.png';
      meta.baseCam = base.cam;
      logs.push(...base.logs);
      await baseContext.close();
    }
  } finally {
    await browser.close();
  }
  meta.logs = badLogs(logs);
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 1));
  const phases = meta.steps.map((step) => (step.phase === undefined ? '?' : step.phase.join(',')));
  console.log(
    `${folder} : caméra (${String(meta.cam.x)}, ${String(meta.cam.y)}), pas ${phases.join(' ')}, ` +
      `${String(Date.now() - started)} ms, journaux ${JSON.stringify(meta.logs)}`,
  );
}

/** Nom d'une vue : son dossier. CONTROL_VIEWS, s'il est donné, n'en garde que certaines. */
const viewName = (view) => `${view.seed}-m${String(view.month)}`;
const only = (process.env.CONTROL_VIEWS ?? '').split(',').filter((name) => name !== '');

(async () => {
  for (const view of VIEWS) {
    if (only.length === 0 || only.includes(viewName(view))) await captureView(view);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
