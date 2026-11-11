// Point d'entrée de l'application : crée le rendu de la carte, l'interface et le worker
// de simulation, puis les relie.
import { h, render } from 'preact';
import { loadGameData, type GameData } from '../core/data';
import { PROTOCOL_VERSION, type InspectTarget } from '../core/protocol';
import { WORLD_SIZES, type WorldLayers, type WorldSizeId } from '../core/world';
import { defaultWorldParams, type WorldParams } from '../core/worldParams';
import { determinismSelfTest } from '../core/selftest';
import { t } from '../i18n';
import { parseColor } from '../render/bake';
import { CameraControls } from '../render/controls';
import { MapView } from '../render/map';
import { legend, overlayTexels } from '../render/mapModes';
import { cellAt, showAt, TILE_PX, type Camera } from '../render/camera';
import { PeopleLayer } from '../render/people';
import { previewPixels } from '../render/preview';
import { SPAWN_COUNT } from '../sim/commands';
import type { SheetContent } from '../ui/Sheet';
import { createRenderer } from '../render/renderer';
import { App } from '../ui/App';
import {
  chronicle,
  chronicleLoading,
  chronicleOpen,
  content as contentInfo,
  creationBusy,
  creationOpen,
  creationPending,
  creatorSetup,
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
  raise,
  sheet,
  showNotice,
  spawnChoice,
  spawnSettings,
  time,
  tool,
  worldInfo,
  type CreationSetup,
  type MapModeId,
} from '../ui/store';
import { appendFacts, olderThan, prependPage } from './chronicle';
import { DebugSampler, usedMemoryMb } from './debug';
import { centerOf, visibleArea, type Rect } from './focus';
import { SaveManager, SaveStore } from './saves';
import { describeCell } from './inspect';
import { SheetRequests } from './sheets';
import { spawnTarget } from './spawn';
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
  // Ce que l'outil d'apparition propose : les espèces des données et leurs sous-espèces.
  const creator = creatorSetup(data.species.entries, SPAWN_COUNT);
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
  // Caméra du dernier dessin : un appui désigne ce que la carte montrait.
  let drawnCamera: Camera | undefined;
  /**
   * Un point de la carte, désigné d'un appui bref (`tap`) ou long : selon l'outil, sa case
   * reçoit un groupe (CRE-03), se peint (débogage), ou s'inspecte (IHM-07) ; un groupe
   * dessiné sous le doigt ouvre sa fiche (IHM-02).
   */
  const designate = (
    mapX: number,
    mapY: number,
    screenX: number,
    screenY: number,
    tap: boolean,
  ) => {
    const info = worldInfo.value;
    if (info === undefined) return;
    // La case du monde, sa colonne ramenée dans le monde, quelle que soit la copie touchée.
    const cell = cellAt(mapX, mapY, info.size.width);
    if (tool.value === 'spawn') {
      spawnAt(cell.x, cell.y);
      return;
    }
    // Débogage : ?brush=desert peint la case touchée de ce biome, par une commande de jeu.
    if (tap && brush !== null) {
      simulation.send({
        type: 'game',
        command: { type: 'paintBiome', x: cell.x, y: cell.y, biome: brush },
      });
      return;
    }
    const group =
      drawnCamera === undefined
        ? undefined
        : people.pick(drawnCamera, map.viewport, map.world, screenX, screenY);
    if (group === undefined) {
      showCell(cell.x, cell.y);
      raise('cell');
    } else {
      // Le groupe montré, la case qu'on inspectait s'efface.
      inspected.value = undefined;
      openSheet({ kind: 'group', id: group });
    }
  };
  const controls = new CameraControls({
    element: mapElement,
    viewport: () => map.viewport,
    resolution: () => app.renderer.resolution,
    world: () => map.world,
    onLongPress: (mapX, mapY, screenX, screenY) => {
      designate(mapX, mapY, screenX, screenY, false);
    },
    onTap: (mapX, mapY, screenX, screenY) => {
      designate(mapX, mapY, screenX, screenY, true);
    },
    // Une apparition ne s'annule pas : outil armé, un appui long attend le relâcher, et ne
    // compte pas s'il est devenu un glisser ou un pincement (U-6).
    holdUntilRelease: () => tool.value === 'spawn',
  });
  // Couches du monde affiché, pour l'inspection et les légendes.
  let worldLayers: WorldLayers | undefined;
  // Fiches (IHM-02) : demandes du joueur et rafraîchissements, numérotés (app/sheets.ts).
  const sheets = new SheetRequests();
  const openSheet = (target: InspectTarget) => {
    simulation.send({ type: 'inspect', ...sheets.open(target) });
    // Sur petit écran, la fiche demandée passe au-dessus, même si elle était déjà ouverte.
    raise('sheet');
  };
  /** Fait apparaître un groupe sur la case, si elle le permet ; un avis dit sinon pourquoi. */
  const spawnAt = (x: number, y: number) => {
    const info = worldInfo.value;
    if (worldLayers === undefined || info === undefined) return;
    const target = spawnTarget(worldLayers, info.size, x, y, data);
    if ('refusal' in target) {
      showNotice(target.refusal);
      return;
    }
    // Les réglages choisis, ou ceux tirés des données (U-11).
    const settings = spawnChoice(creator, spawnSettings.value);
    if (settings === undefined) return;
    simulation.send({
      type: 'game',
      command: { type: 'spawnGroup', x: target.x, y: target.y, ...settings },
    });
  };
  const uiElement = element('ui');
  /**
   * Ce qui couvre la carte : les panneaux de l'interface et le bouton du débogage, et la
   * colonne de droite entière dès qu'un panneau s'y montre, car la fiche qui s'ouvre y
   * prendra sa place.
   */
  const covers = (): Rect[] => {
    const rects: Rect[] = [...uiElement.querySelectorAll('.panel, .debug-toggle')].map((panel) =>
      panel.getBoundingClientRect(),
    );
    const side = uiElement.querySelector('.hud-side');
    const shown = [...(side?.querySelectorAll('.panel') ?? [])].some(
      (panel) => panel.getClientRects().length > 0,
    );
    if (side !== null && shown) rects.push(side.getBoundingClientRect());
    return rects;
  };
  /** Montre la case (x, y) dans le panneau d'inspection, au mois courant. */
  const showCell = (x: number, y: number) => {
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
  // La température du mois de la case inspectée suit le temps qui passe ; rien de plus :
  // une case inspectée n'ouvre jamais d'elle-même la fiche d'un groupe qui passe.
  const refreshInspected = () => {
    const cell = inspected.value;
    if (cell !== undefined) showCell(cell.x, cell.y);
  };
  // Chronique : numéro de la dernière page demandée, et pages plus anciennes à garder, tant
  // que la chronique reste ouverte.
  let chronicleRequest = 0;
  let olderKept = false;
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
    drawnCamera = camera;
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
    // La fiche ouverte suit la vie de l'individu ou du groupe, chaque seconde, sauf si une
    // réponse est attendue : un rafraîchissement ne passe pas devant un clic.
    if (++sheetRefresh % 4 === 0) {
      const request = sheets.refresh();
      if (request !== undefined) simulation.send({ type: 'inspect', ...request });
    }
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
        // Une autre partie : les réponses attendues portent sur l'ancienne, et sont ignorées.
        sheets.close();
        sheet.value = undefined;
        people.clear();
        people.setFrame(message.frame);
        chronicleRequest++;
        chronicleLoading.value = false;
        olderKept = false;
        chronicle.value = message.chronicle;
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
        // Les pages plus anciennes se gardent tant que la chronique reste ouverte.
        if (!chronicleOpen.value) olderKept = false;
        chronicle.value = appendFacts(chronicle.value, message.chronicle, olderKept);
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
        // La fiche demandée, ou sa fermeture si sa cible n'est plus ; une réponse
        // dépassée (autre cible, autre partie, fiche fermée) ne change rien.
        const shown = sheets.receive(message);
        if (shown !== undefined) sheet.value = shown ?? undefined;
        break;
      }
      case 'chroniclePage':
        if (message.requestId !== chronicleRequest) break;
        chronicleLoading.value = false;
        chronicle.value = prependPage(chronicle.value, message.facts);
        break;
      case 'error':
        console.error(`worker : ${message.code} (${message.detail})`);
        // Une commande refusée ou écartée, comme un groupe sur une case infranchissable.
        if (message.code === 'command') showNotice('command.refused');
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
      openSheet({ kind: 'person', id });
    },
    inspectGroup: (id: number) => {
      openSheet({ kind: 'group', id });
    },
    closeSheet: () => {
      sheets.close();
      sheet.value = undefined;
    },
    olderChronicle: () => {
      const before = olderThan(chronicle.value);
      if (before === undefined || chronicleLoading.value) return;
      olderKept = true;
      chronicleLoading.value = true;
      chronicleRequest++;
      simulation.send({ type: 'chronicle', requestId: chronicleRequest, before });
    },
    focus: (x: number, y: number) => {
      // Le lieu au milieu de la partie visible de la carte, et non sous les panneaux (U-5).
      const hud = uiElement.querySelector('.hud') ?? uiElement;
      const center = centerOf(visibleArea(hud.getBoundingClientRect(), covers()));
      const origin = mapElement.getBoundingClientRect();
      const resolution = app.renderer.resolution;
      controls.camera = showAt(
        controls.camera,
        map.viewport,
        x * TILE_PX + TILE_PX / 2,
        y * TILE_PX + TILE_PX / 2,
        (center.x - origin.left) * resolution,
        (center.y - origin.top) * resolution,
      );
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
  const content: SheetContent = {
    species: data.species.entries,
    genetics: data.genetics,
    appearance: data.appearance,
  };
  render(h(App, { actions, setup, creator, content }), uiElement);

  // La poignée de main d'abord : le worker refuse tout message qui la précède.
  simulation.send({ type: 'hello', protocol: PROTOCOL_VERSION });
  // Débogage : ?stepCost=200 ajoute un coût factice de 200 ms à chaque pas.
  const stepCost = Number(query.get('stepCost') ?? 0);
  if (stepCost > 0) simulation.send({ type: 'debugStepCost', milliseconds: stepCost });
}

void main();
