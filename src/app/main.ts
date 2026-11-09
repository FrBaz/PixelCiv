// Point d'entrée de l'application : crée le rendu de la carte, l'interface et le worker
// de simulation, puis les relie.
import { h, render } from 'preact';
import { loadGameData, type GameData } from '../core/data';
import { PROTOCOL_VERSION } from '../core/protocol';
import { WORLD_SIZES, type WorldLayers, type WorldSizeId } from '../core/world';
import { defaultWorldParams, type WorldParams } from '../core/worldParams';
import { determinismSelfTest } from '../core/selftest';
import { t } from '../i18n';
import { CameraControls } from '../render/controls';
import { cellAt, MapView } from '../render/map';
import { legend, overlayTexels } from '../render/mapModes';
import { createRenderer } from '../render/renderer';
import { App } from '../ui/App';
import {
  content,
  debugInfo,
  determinismOk,
  generation,
  generationMs,
  inspected,
  legendEntries,
  mapMode,
  time,
  worldInfo,
  type MapModeId,
} from '../ui/store';
import { DebugSampler, usedMemoryMb } from './debug';
import { SaveManager, SaveStore } from './saves';
import { describeCell } from './inspect';
import { SeasonClock } from './seasonClock';
import { SimulationClient } from './simulation';
import './style.css';

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`élément #${id} introuvable`);
  return found;
}

/**
 * Paramètres de la première partie, sans sauvegarde à reprendre : ceux par défaut, ou
 * ceux de l'adresse, pour le débogage (?seed=abc&size=large).
 */
function startingParams(data: GameData, query: URLSearchParams): WorldParams {
  const size = query.get('size') ?? 'small';
  const seed = query.get('seed') ?? 'pixelciv';
  const sizeId: WorldSizeId = Object.hasOwn(WORLD_SIZES, size) ? (size as WorldSizeId) : 'small';
  return defaultWorldParams(data.worldgen.parameters, seed.slice(0, 64) || 'pixelciv', sizeId);
}

async function main(): Promise<void> {
  document.title = t('app.title');
  // Le contenu est validé au démarrage : une donnée invalide lève ici une DataError.
  const data = loadGameData();
  content.value = { biomes: data.biomes.entries.length };
  // Auto-test du déterminisme : ce moteur redonne-t-il les empreintes de référence ?
  determinismOk.value = determinismSelfTest();
  const query = new URLSearchParams(location.search);
  const brush = query.get('brush');
  const mapElement = element('map');
  const app = await createRenderer(mapElement);
  const map = new MapView(app, data.biomes.entries);
  const seasons = new SeasonClock();
  const modeData = {
    biomes: data.biomes.entries,
    altitudeLevels: data.altitudeLevels.entries,
    resources: data.resources.entries,
  };
  const simulation = new SimulationClient();
  // Sans IndexedDB (navigation privée, stockage refusé), le jeu tourne sans sauvegarde locale.
  const store = await SaveStore.open().catch(() => undefined);
  const saves = new SaveManager(simulation, store);
  const controls = new CameraControls({
    element: mapElement,
    viewport: () => map.viewport,
    resolution: () => app.renderer.resolution,
    world: () => map.world,
    onTap: (mapX, mapY) => {
      const cell = cellAt(mapX, mapY);
      // Débogage : ?brush=desert peint la case touchée de ce biome, par une commande de jeu.
      if (brush !== null) {
        simulation.send({
          type: 'game',
          command: { type: 'paintBiome', x: cell.x, y: cell.y, biome: brush },
        });
        return;
      }
      inspect(cell.x, cell.y);
    },
  });
  // Couches du monde affiché, pour l'inspection et les légendes.
  let worldLayers: WorldLayers | undefined;
  const inspect = (x: number, y: number) => {
    const info = worldInfo.value;
    if (worldLayers === undefined || info === undefined) return;
    inspected.value = describeCell(
      worldLayers,
      info.size,
      x,
      y,
      seasons.month(performance.now()),
      data,
    );
  };
  const sampler = new DebugSampler();
  // Au retour d'un onglet masqué, la première image couvre toute l'absence : elle ne
  // compte pas comme une image lente.
  let returning = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') returning = true;
  });
  app.ticker.add((ticker) => {
    // La durée réelle de l'image : deltaMS est plafonné à 100 ms, et cacherait les à-coups.
    if (returning) returning = false;
    else sampler.frame(ticker.elapsedMS);
    map.setSeason(seasons.month(performance.now()));
    map.draw(controls.update(ticker.deltaMS));
  });
  setInterval(() => {
    const renderer = { name: app.renderer.name, resolution: app.renderer.resolution };
    debugInfo.value = {
      ...sampler.sample(),
      memoryMb: usedMemoryMb(),
      renderer,
      chunks: map.pendingChunks,
    };
  }, 250);

  simulation.subscribe((message) => {
    switch (message.type) {
      case 'ready':
        // Reprend la dernière partie si elle a été sauvegardée, sinon en commence une.
        void saves
          .resume()
          .catch((error: unknown) => {
            console.error(error);
            return false;
          })
          .then((resumed) => {
            if (!resumed) simulation.send({ type: 'newGame', params: startingParams(data, query) });
            saves.startAutosave();
          });
        break;
      case 'snapshot': {
        worldInfo.value = message.world;
        const layers = message.layers;
        worldLayers = layers;
        inspected.value = undefined;
        map.setWorld(message.world, layers, (mode) => overlayTexels(mode, layers, modeData));
        actions.setMapMode(mapMode.value);
        const world = map.world;
        if (world !== undefined) controls.center(world);
        time.value = message.time;
        seasons.update(message.time, performance.now());
        break;
      }
      case 'delta':
        map.updateChunks(message.chunks);
        time.value = message.time;
        seasons.update(message.time, performance.now());
        break;
      case 'time':
        time.value = message.time;
        seasons.update(message.time, performance.now());
        break;
      case 'stats':
        sampler.step(message.stats.stepMs);
        break;
      case 'progress':
        generation.value = { stage: message.stage, step: message.step, steps: message.steps };
        break;
      case 'generated':
        generation.value = undefined;
        generationMs.value = message.milliseconds;
        break;
      case 'previewReady':
        // Réponse aux aperçus de l'écran de création (tâche 1.9).
        break;
      case 'error':
        console.error(`worker : ${message.code} (${message.detail})`);
        break;
      case 'saved':
      case 'saveFailed':
      case 'loaded':
      case 'loadFailed':
        // Réponses aux requêtes de SaveManager, qui les attend.
        break;
    }
  });
  const actions = {
    send: (message: Parameters<SimulationClient['send']>[0]) => {
      simulation.send(message);
    },
    setMapMode: (mode: MapModeId) => {
      mapMode.value = mode;
      map.setMode(mode);
      legendEntries.value =
        mode === 'natural' || worldLayers === undefined ? [] : legend(mode, worldLayers, modeData);
    },
    save: () => saves.save(),
    load: () => saves.load(),
    exportFile: () => saves.exportFile(),
    importFile: (file: File) => saves.importFile(file),
  };
  render(h(App, { actions }), element('ui'));

  // La poignée de main d'abord : le worker refuse tout message qui la précède.
  simulation.send({ type: 'hello', protocol: PROTOCOL_VERSION });
  // Débogage : ?stepCost=200 ajoute un coût factice de 200 ms à chaque pas.
  const stepCost = Number(query.get('stepCost') ?? 0);
  if (stepCost > 0) simulation.send({ type: 'debugStepCost', milliseconds: stepCost });
}

void main();
