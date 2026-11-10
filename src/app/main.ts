// Point d'entrée de l'application : crée le rendu de la carte, l'interface et le worker
// de simulation, puis les relie.
import { h, render } from 'preact';
import { loadGameData, type GameData } from '../core/data';
import { PROTOCOL_VERSION, type InspectTarget } from '../core/protocol';
import { WORLD_SIZES, type WorldLayers, type WorldSizeId } from '../core/world';
import { defaultWorldParams, type WorldParams } from '../core/worldParams';
import { determinismSelfTest } from '../core/selftest';
import { t, type MessageKey } from '../i18n';
import { parseColor } from '../render/bake';
import { CameraControls } from '../render/controls';
import { cellAt, MapView } from '../render/map';
import { legend, overlayTexels } from '../render/mapModes';
import { TILE_PX } from '../render/camera';
import { PeopleLayer } from '../render/people';
import { previewPixels } from '../render/preview';
import { SPAWN_COUNT } from '../sim/commands';
import type { SheetContent } from '../ui/Sheet';
import { createRenderer } from '../render/renderer';
import { App } from '../ui/App';
import {
  chronicle,
  CHRONICLE_KEPT,
  content as contentInfo,
  creationBusy,
  creationOpen,
  creationPending,
  debugInfo,
  determinismOk,
  generation,
  generationMs,
  inspected,
  legendEntries,
  mapMode,
  PREVIEW_COLUMNS,
  previewImage,
  previewKey,
  sheet,
  showNotice,
  spawnSettings,
  time,
  tool,
  worldInfo,
  type CreationSetup,
  type CreatorSetup,
  type MapModeId,
} from '../ui/store';
import { DebugSampler, usedMemoryMb } from './debug';
import { SaveManager, SaveStore } from './saves';
import { describeCell } from './inspect';
import { PreviewScheduler } from './preview';
import { SeasonClock } from './seasonClock';
import { SimulationClient } from './simulation';
import './style.css';

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`élément #${id} introuvable`);
  return found;
}

/**
 * Débogage : l'adresse peut nommer le monde de la première partie (?seed=abc&size=large),
 * qui commence alors sans passer par l'écran de création.
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
  contentInfo.value = { biomes: data.biomes.entries.length };
  // Auto-test du déterminisme : ce moteur redonne-t-il les empreintes de référence ? Le
  // worker y ajoute celle du monde de référence, à la poignée de main.
  const determinism = determinismSelfTest();
  const query = new URLSearchParams(location.search);
  const brush = query.get('brush');
  const mapElement = element('map');
  const app = await createRenderer(mapElement);
  const map = new MapView(app, data.biomes.entries);
  const people = new PeopleLayer(app, { genetics: data.genetics, appearance: data.appearance });
  const seasons = new SeasonClock();
  const modeData = {
    biomes: data.biomes.entries,
    altitudeLevels: data.altitudeLevels.entries,
    resources: data.resources.entries,
  };
  // Au doigt seul (téléphone, tablette) : un monde Moyen par défaut, en attendant la
  // mesure sur téléphone, et pas d'Immense, réservé au PC (MON-02).
  const touchOnly = !matchMedia('(any-pointer: fine)').matches;
  const setup: CreationSetup = {
    parameters: data.worldgen.parameters,
    sizes: touchOnly ? ['small', 'medium', 'large'] : ['small', 'medium', 'large', 'huge'],
    defaultSize: touchOnly ? 'medium' : 'large',
  };
  const simulation = new SimulationClient();
  const biomeColors = data.biomes.entries.map((biome) => parseColor(biome.palette.base));
  const biomeWater = data.biomes.entries.map((biome) => biome.tile === 'water');
  const previews = new PreviewScheduler(
    (requestId, params) => {
      simulation.send({ type: 'preview', requestId, params, width: PREVIEW_COLUMNS });
    },
    (preview, params) => {
      previewImage.value = {
        width: preview.size.width,
        height: preview.size.height,
        pixels: previewPixels(
          preview.size,
          preview.biome,
          preview.elevation,
          biomeColors,
          biomeWater,
        ),
        key: previewKey(params),
      };
    },
    {
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: (handle) => {
        window.clearTimeout(handle);
      },
    },
  );
  // Sans IndexedDB (navigation privée, stockage refusé), le jeu tourne sans sauvegarde locale.
  const store = await SaveStore.open().catch(() => undefined);
  const saves = new SaveManager(simulation, store);
  const controls = new CameraControls({
    element: mapElement,
    viewport: () => map.viewport,
    resolution: () => app.renderer.resolution,
    world: () => map.world,
    // Appui long au doigt, clic ou appui bref : la case désignée s'inspecte (IHM-07), ou
    // reçoit le groupe de l'outil d'apparition (CRE-03).
    onLongPress: (mapX, mapY) => {
      const cell = cellAt(mapX, mapY);
      if (tool.value === 'spawn') spawnAt(cell.x, cell.y);
      else inspect(cell.x, cell.y);
    },
    onTap: (mapX, mapY) => {
      const cell = cellAt(mapX, mapY);
      if (tool.value === 'spawn') {
        spawnAt(cell.x, cell.y);
        return;
      }
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
  // Fiches (IHM-02) : la dernière demande, et la cible de la fiche ouverte, qu'on rafraîchit.
  let inspectRequest = 0;
  let sheetTarget: InspectTarget | undefined;
  const requestSheet = (target: InspectTarget) => {
    inspectRequest++;
    simulation.send({ type: 'inspect', requestId: inspectRequest, target });
  };
  /** Fait apparaître un groupe sur une case de terre ; un avis sinon. */
  const spawnAt = (x: number, y: number) => {
    const info = worldInfo.value;
    if (worldLayers === undefined || info === undefined) return;
    const biome = data.biomes.entries.at(worldLayers.biome[y * info.size.width + x] ?? 0);
    if (biome === undefined || biome.movementCost === null) {
      showNotice('creator.water');
      return;
    }
    const settings = spawnSettings.value;
    simulation.send({ type: 'game', command: { type: 'spawnGroup', x, y, ...settings } });
  };
  const inspect = (x: number, y: number) => {
    const info = worldInfo.value;
    if (worldLayers === undefined || info === undefined) return;
    // Un groupe tout près ouvre sa fiche ; la case s'inspecte toujours.
    requestSheet({ kind: 'place', x, y });
    inspected.value = describeCell(
      worldLayers,
      info.size,
      x,
      y,
      seasons.month(performance.now()),
      data,
    );
  };
  // La température du mois de la case inspectée suit le temps qui passe.
  const refreshInspected = () => {
    const cell = inspected.value;
    if (cell !== undefined) inspect(cell.x, cell.y);
  };
  // Le jeu se met en pause pendant l'écran de création, et reprend à sa fermeture s'il
  // tournait.
  let pausedForCreation = false;
  const leaveCreation = () => {
    creationOpen.value = false;
    previews.cancel();
    if (pausedForCreation) simulation.send({ type: 'setPaused', paused: false });
    pausedForCreation = false;
  };
  const sampler = new DebugSampler();
  let sheetRefresh = 0;
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
    const camera = controls.update(ticker.deltaMS);
    map.draw(camera);
    people.draw(camera, map.viewport, map.world, performance.now());
  });
  setInterval(() => {
    const renderer = { name: app.renderer.name, resolution: app.renderer.resolution };
    debugInfo.value = {
      ...sampler.sample(),
      memoryMb: usedMemoryMb(),
      renderer,
      chunks: map.pendingChunks,
    };
    refreshInspected();
    // La fiche ouverte suit la vie de l'individu ou du groupe, chaque seconde.
    if (sheetTarget !== undefined && ++sheetRefresh % 4 === 0) requestSheet(sheetTarget);
  }, 250);

  simulation.subscribe((message) => {
    switch (message.type) {
      case 'ready':
        determinismOk.value = determinism && message.determinism;
        // Reprend la dernière partie si elle a été sauvegardée, sinon ouvre l'écran de création.
        void saves
          .resume()
          .catch((error: unknown) => {
            console.error(error);
            return false;
          })
          .then((resumed) => {
            if (!resumed) {
              if (query.has('seed') || query.has('size')) {
                simulation.send({ type: 'newGame', params: startingParams(data, query) });
              } else {
                creationOpen.value = true;
              }
            }
            saves.startAutosave();
          });
        break;
      case 'snapshot': {
        // Une partie commence : l'écran de création se ferme s'il l'a demandée (nouveau
        // monde, chargement), et reste ouvert sinon (reprise arrivée après son ouverture).
        if (creationPending.value || creationBusy.value) leaveCreation();
        creationPending.value = false;
        worldInfo.value = message.world;
        const layers = message.layers;
        worldLayers = layers;
        inspected.value = undefined;
        sheet.value = undefined;
        sheetTarget = undefined;
        people.clear();
        people.setFrame(message.frame);
        chronicle.value = message.chronicle.slice(-CHRONICLE_KEPT);
        const { width } = message.world.size;
        map.setWorld(message.world, layers, (mode) => overlayTexels(mode, layers, modeData, width));
        actions.setMapMode(mapMode.value);
        const world = map.world;
        if (world !== undefined) controls.center(world);
        time.value = message.time;
        seasons.update(message.time, performance.now());
        break;
      }
      case 'delta':
        map.updateChunks(message.chunks);
        people.setFrame(message.frame);
        if (message.chronicle.length > 0) {
          chronicle.value = [...chronicle.value, ...message.chronicle].slice(-CHRONICLE_KEPT);
        }
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
        previews.ready(message);
        break;
      case 'inspection': {
        // Seule compte la réponse à la dernière demande.
        if (message.requestId !== inspectRequest) break;
        if (message.person !== undefined) {
          sheet.value = { kind: 'person', view: message.person };
          sheetTarget = { kind: 'person', id: message.person.id };
        } else if (message.group !== undefined) {
          sheet.value = { kind: 'group', view: message.group };
          sheetTarget = { kind: 'group', id: message.group.id };
          // Le groupe montré, sa case s'efface de l'inspection.
          inspected.value = undefined;
        } else if (sheetTarget?.kind === 'group') {
          // Le groupe n'est plus : sa fiche se ferme.
          sheet.value = undefined;
          sheetTarget = undefined;
        }
        break;
      }
      case 'error':
        console.error(`worker : ${message.code} (${message.detail})`);
        if (message.code === 'params' || message.code === 'internal') {
          // Un aperçu ou un monde demandé ne viendra pas.
          previews.failed();
          if (creationPending.value) {
            creationPending.value = false;
            generation.value = undefined;
            showNotice('create.error');
          }
        }
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
    inspectPerson: (id: number) => {
      requestSheet({ kind: 'person', id });
    },
    inspectGroup: (id: number) => {
      requestSheet({ kind: 'group', id });
    },
    closeSheet: () => {
      sheet.value = undefined;
      sheetTarget = undefined;
    },
    focus: (x: number, y: number) => {
      controls.camera = {
        ...controls.camera,
        x: x * TILE_PX + TILE_PX / 2,
        y: y * TILE_PX + TILE_PX / 2,
      };
    },
    setMapMode: (mode: MapModeId) => {
      mapMode.value = mode;
      map.setMode(mode);
      legendEntries.value =
        mode === 'natural' || worldLayers === undefined ? [] : legend(mode, worldLayers, modeData);
    },
    save: () => saves.save(),
    load: () => fromCreation(() => saves.load()),
    exportFile: () => saves.exportFile(),
    importFile: (file: File) => fromCreation(() => saves.importFile(file)),
    openCreation: () => {
      creationOpen.value = true;
      const current = time.value;
      if (current !== undefined && !current.paused) {
        pausedForCreation = true;
        simulation.send({ type: 'setPaused', paused: true });
      }
    },
    closeCreation: leaveCreation,
    preview: (params: WorldParams) => {
      previews.request(params);
    },
    create: (params: WorldParams) => {
      creationPending.value = true;
      generation.value = undefined;
      simulation.send({ type: 'newGame', params });
    },
  };
  /** Un chargement demandé depuis l'écran de création l'occupe jusqu'à la réponse. */
  async function fromCreation(load: () => Promise<void>): Promise<void> {
    if (!creationOpen.value) {
      await load();
      return;
    }
    creationBusy.value = true;
    try {
      await load();
    } finally {
      creationBusy.value = false;
    }
  }
  const creator: CreatorSetup = {
    species: data.species.entries.map((species) => ({
      id: species.id,
      name: species.name as MessageKey,
      subspecies: species.subspecies.map((entry) => ({
        id: entry.id,
        name: entry.name as MessageKey,
      })),
    })),
    count: SPAWN_COUNT,
  };
  const content: SheetContent = {
    species: data.species.entries,
    loci: data.genetics.loci,
    traits: data.genetics.traits,
    appearance: data.appearance,
  };
  render(h(App, { actions, setup, creator, content }), element('ui'));

  // La poignée de main d'abord : le worker refuse tout message qui la précède.
  simulation.send({ type: 'hello', protocol: PROTOCOL_VERSION });
  // Débogage : ?stepCost=200 ajoute un coût factice de 200 ms à chaque pas.
  const stepCost = Number(query.get('stepCost') ?? 0);
  if (stepCost > 0) simulation.send({ type: 'debugStepCost', milliseconds: stepCost });
}

void main();
