// Captures du contrôle des pixels des couleurs de la saison (ADR 0019, § 8 ; LISEZMOI.md).
//
// node tools/season-control/capture.cjs <adresse> <dossier> [adresse d'avant]
//
// Pour chaque vue de VIEWS : un monde Petit, sur PC (1 280 × 720, densité 1), au zoom 1 (0,75
// pour les vues de loin), au
// mois forcé par ?month=, la mer immobile (?waves=off), la partie en pause dès sa création, la
// carte visée par ?at=, l'interface masquée. Trois captures, une par cran du réglage des effets
// (?effects=full, reduced, off), et, avec l'adresse d'une construction d'avant le second temps de
// 2b.7, une capture de celle-ci au même endroit. Chaque vue écrit ses PNG et son meta.json dans
// <dossier>/<graine>-<x>-<y>-m<mois>/, que pixels.control.ts compare ensuite au miroir du shader.
// CONTROL_VIEWS=pixelciv-412-62-m9.5 n'en capture que certaines.
//
// Playwright n'est pas une dépendance du projet : le script le prend là où Node le trouve.
//
// Un script CommonJS, hors des programmes TypeScript : Node lui fournit require, process et
// console ; la page, window, Worker et requestAnimationFrame.
/* global require, process, console, window, Worker, requestAnimationFrame */
/* eslint-disable @typescript-eslint/no-require-imports -- un script CommonJS lancé par Node */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

/**
 * Les vues : des forêts et des prairies du nord à l'automne, au cœur de l'hiver, au printemps et
 * au cœur de l'été ; la toundra et les steppes ; la saison sèche des tropiques ; le sud. Le centre
 * est une case (x, y).
 */
const VIEWS = [
  { seed: 'pixelciv', x: 412, y: 62, month: 9.5 },
  { seed: 'pixelciv', x: 412, y: 62, month: 0.5 },
  { seed: 'pixelciv', x: 412, y: 62, month: 3.6 },
  { seed: 'pixelciv', x: 412, y: 62, month: 6.5 },
  { seed: 'pixelciv', x: 330, y: 190, month: 9.5 },
  { seed: 'graine', x: 308, y: 47, month: 9.8 },
  { seed: 'graine', x: 303, y: 150, month: 1.5 },
  { seed: 'autre', x: 235, y: 33, month: 10.5 },
  { seed: 'autre', x: 53, y: 190, month: 4.2 },
  // De loin (une échelle sous 1, la branche des mipmaps) : les rivières et les côtes de l'automne
  // gardent leurs tons cuits (relecture de 2b.7, problème 2).
  { seed: 'graine', x: 308, y: 47, month: 9.8, zoom: 0.75 },
  { seed: 'pixelciv', x: 412, y: 62, month: 9.8, zoom: 0.75 },
];
const LEVELS = ['full', 'reduced', 'off'];
const SPAN = 2048;
const PC = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };
const HIDE_UI = '#ui { visibility: hidden !important; }';

const [address, out, baseAddress] = process.argv.slice(2);
if (address === undefined || out === undefined) {
  console.error('node capture.cjs <adresse> <dossier> [adresse d’avant]');
  process.exit(2);
}

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

/** Centre de l'écran en pixels de carte, taille de l'écran, et les blocs des saisons dessinés. */
async function camera(page) {
  return page.evaluate((span) => {
    const app = window.__app;
    const res = app.renderer.resolution;
    const vw = Math.round(app.screen.width * res);
    const vh = Math.round(app.screen.height * res);
    const meshes = [];
    const walk = (node) => {
      for (const child of node.children ?? []) {
        const resources = child.shader?.resources;
        const origin = resources?.origin?.uniforms?.uOrigin;
        if (child.visible && origin !== undefined) {
          meshes.push({
            column: origin[0] / 64,
            row: origin[1] / 64,
            left: child.position.x * res,
            top: child.position.y * res,
            width: child.scale.x * res * 256,
            seasons: resources.seasons !== undefined,
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
      seasonMeshes: meshes.filter((mesh) => mesh.seasons).length,
    };
  }, SPAN);
}

async function frames(page, count = 4) {
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

/** Journaux inattendus ; SwiftShader se plaint des lectures de pixels des captures. */
const badLogs = (logs) =>
  logs.filter(
    (line) =>
      /^\[(error|warning|pageerror)\]/.test(line) && !/GPU stall due to ReadPixels/.test(line),
  );

/** Une capture de `url` pour la vue, au cran `level` (ou sans cran). */
async function shoot(browser, url, view, level, file) {
  const context = await browser.newContext(PC);
  await context.addInitScript(init);
  const page = await context.newPage();
  const logs = [];
  page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
  const effects = level === undefined ? '' : `&effects=${level}`;
  await page.goto(
    `${url}?seed=${encodeURIComponent(view.seed)}&size=small&zoom=${String(view.zoom ?? 1)}&waves=off` +
      `&month=${String(view.month)}&at=${String(view.x)},${String(view.y)}${effects}`,
  );
  await page.waitForSelector('.time-date', { timeout: 180_000 });
  await page.waitForFunction(() => window.__app !== undefined, null, { timeout: 60_000 });
  await baked(page);
  await page.addStyleTag({ content: HIDE_UI });
  await frames(page);
  const cam = await camera(page);
  await page.screenshot({ path: file });
  await context.close();
  return { cam, logs: badLogs(logs) };
}

async function captureView(view) {
  const folder = path.join(out, viewName(view));
  fs.mkdirSync(folder, { recursive: true });
  const started = Date.now();
  const meta = { seed: view.seed, month: view.month, zoom: view.zoom ?? 1, shots: {}, logs: [] };
  // Un navigateur par vue, fermé aussitôt : la mémoire du conteneur est comptée.
  const browser = await chromium.launch();
  try {
    for (const level of LEVELS) {
      const shot = await shoot(browser, address, view, level, path.join(folder, `${level}.png`));
      meta.shots[level] = { file: `${level}.png`, cam: shot.cam };
      meta.logs.push(...shot.logs);
    }
    if (baseAddress !== undefined) {
      const shot = await shoot(
        browser,
        baseAddress,
        view,
        undefined,
        path.join(folder, 'base.png'),
      );
      meta.shots.base = { file: 'base.png', cam: shot.cam };
      meta.logs.push(...shot.logs);
    }
  } finally {
    await browser.close();
  }
  meta.cam = meta.shots.full.cam;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 1));
  const cams = Object.entries(meta.shots).map(
    ([level, shot]) =>
      `${level} (${String(shot.cam.x)}, ${String(shot.cam.y)}) ${String(shot.cam.seasonMeshes)}/${String(shot.cam.meshes)}`,
  );
  console.log(
    `${folder} : ${cams.join(' · ')}, ${String(Date.now() - started)} ms, journaux ${JSON.stringify(meta.logs)}`,
  );
}

/** Nom d'une vue : son dossier. CONTROL_VIEWS, s'il est donné, n'en garde que certaines. */
const viewName = (view) =>
  `${view.seed}-${String(view.x)}-${String(view.y)}-m${String(view.month)}` +
  (view.zoom === undefined ? '' : `-z${String(view.zoom)}`);
const only = (process.env.CONTROL_VIEWS ?? '').split(',').filter((name) => name !== '');

(async () => {
  for (const view of VIEWS) {
    if (only.length === 0 || only.includes(viewName(view))) await captureView(view);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
