// Point d'entrée de l'application : crée le rendu de la carte, l'interface et le worker
// de simulation, puis les relie.
import { h, render } from 'preact';
import { loadGameData, type GameData } from '../core/data';
import { frameBuffers, legBuffers, PROTOCOL_VERSION, type InspectTarget } from '../core/protocol';
import { dayIndex, SPEED_FACTORS, type GameTime } from '../core/time';
import { WORLD_SIZES, type WorldLayers, type WorldSizeId } from '../core/world';
import { defaultWorldParams, type WorldParams } from '../core/worldParams';
import { determinismSelfTest } from '../core/selftest';
import { t } from '../i18n';
import { parseColor } from '../render/bake';
import { CameraControls } from '../render/controls';
import { MapView } from '../render/map';
import { legend, overlayTexels } from '../render/mapModes';
import {
  cellAt,
  displayScale,
  openingZoom,
  parseZoom,
  showAt,
  SMALL_SCREEN_QUERY,
  TILE_PX,
  type Camera,
} from '../render/camera';
import { FINGER_SLOP, POINTER_SLOP } from '../render/crowd';
import { PeopleLayer, stepDuration } from '../render/people';
import { previewPixels } from '../render/preview';
import { SPAWN_COUNT } from '../sim/commands';
import { walkCost } from '../sim/terrain';
import type { SheetContent } from '../ui/Sheet';
import { createRenderer } from '../render/renderer';
import { App } from '../ui/App';
import { escapeKey } from '../ui/escape';
import {
  chronicle,
  chronicleLoading,
  chronicleNewFacts,
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
  shownDay,
  showNotice,
  spawnChoice,
  spawnSettings,
  time,
  tool,
  worldInfo,
  type CreationSetup,
  type MapModeId,
} from '../ui/store';
import {
  freezeFacts,
  snapshotFacts,
  latestFacts,
  newFacts,
  olderThan,
  receiveFacts,
  receivePage,
  type KeptFacts,
} from './chronicle';
import { DebugSampler, DrawCallCounter, positionBytes, usedMemoryMb } from './debug';
import { centerOf, visibleArea, type Rect } from './focus';
import { SaveManager, SaveStore } from './saves';
import { describeCell } from './inspect';
import { SheetRequests } from './sheets';
import { crowdCells, crowdGroups, CROWD_GROUP, OccupiedCells, spawnTarget } from './spawn';
import { CrowdTimeline } from './frames';
import { GameClock } from './gameClock';
import { PreviewScheduler } from './preview';
import { SimulationClient } from './simulation';
import './style.css';

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`élément #${id} introuvable`);
  return found;
}

/**
 * Débogage : l'adresse peut nommer le monde de la première partie (?seed=abc&size=large),
 * qui commence alors sans passer par l'écran de création. Elle peut aussi fixer le zoom
 * des parties qui s'ouvrent (?zoom=4, en pixels CSS par pixel de carte ; parseZoom).
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
  // L'espèce de référence : la stature de son adulte moyen fixe la densité des individus de
  // la vue, et l'écart de ses nourrissons portés (ADR 0014, § 6).
  const species = data.species.entries.at(0);
  if (species === undefined) throw new Error('aucune espèce dans les données');
  const people = new PeopleLayer(app, {
    genetics: data.genetics,
    appearance: data.appearance,
    reference: species.display.stature,
  });
  // Couches du monde affiché, pour l'inspection, les légendes et la franchissabilité.
  let worldLayers: WorldLayers | undefined;
  /**
   * La case, comptée comme cellIndex, se franchit-elle ? Comme pour la simulation (walkCost),
   * gardé par case : 1 oui, 2 non, 0 pas encore lu. Une case repeinte s'oublie.
   */
  let passability = new Uint8Array(0);
  const passable = (cell: number): boolean => {
    const known = passability[cell] ?? 0;
    if (known !== 0) return known === 1;
    if (worldLayers === undefined || cell < 0 || cell >= passability.length) return false;
    const open = Number.isFinite(walkCost(worldLayers, cell, data));
    passability[cell] = open ? 1 : 2;
    return open;
  };
  // Horloge du rendu (ADR 0013) : la carte, ses saisons et la date montrent l'instant de
  // l'horloge, un peu en retard sur le dernier état reçu. Les images des groupes et les
  // étapes datées donnent la position de chacun à cet instant (ADR 0014) ; leurs tampons
  // lus retournent au worker, qui les reprend.
  const clock = new GameClock();
  const crowd = new CrowdTimeline({
    carry: species.display.carry,
    passable,
    recycleFrame: (frame) => {
      simulation.send({ type: 'recycle', buffers: frameBuffers(frame) });
    },
    recycleLegs: (legs) => {
      simulation.send({ type: 'recycle', buffers: legBuffers(legs) });
    },
  });
  const modeData = {
    biomes: data.biomes.entries,
    altitudeLevels: data.altitudeLevels.entries,
    resources: data.resources.entries,
  };
  // Au doigt seul (téléphone, tablette) : un monde Moyen par défaut, en attendant la
  // mesure sur téléphone, et pas d'Immense, réservé au PC (MON-02).
  const touchOnly = !matchMedia('(any-pointer: fine)').matches;
  // Téléphone : au doigt seul, sur le petit écran de la mise en page (style.css). Une partie
  // s'y ouvre au zoom 3, et au zoom 2 ailleurs (openingZoom, 2b.1).
  const smallScreen = matchMedia(SMALL_SCREEN_QUERY);
  const queryZoom = parseZoom(query.get('zoom'));
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
   * Un point de la carte, désigné d'un appui bref (`tap`) ou long, du doigt (`finger`) ou
   * d'un pointeur fin : selon l'outil, sa case reçoit un groupe (CRE-03), se peint
   * (débogage), ou s'inspecte (IHM-07). On touche ce qu'on voit : un individu dessiné sous
   * l'appui ouvre sa fiche, une bannière ou l'espace entre les membres d'un groupe celle du
   * groupe (IHM-02, render/crowd.ts, pickEntity).
   */
  const designate = (
    mapX: number,
    mapY: number,
    screenX: number,
    screenY: number,
    tap: boolean,
    finger: boolean,
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
    const picked =
      drawnCamera === undefined
        ? undefined
        : people.pick(screenX, screenY, finger ? FINGER_SLOP : POINTER_SLOP);
    if (picked === undefined) {
      showCell(cell.x, cell.y);
      raise('cell');
    } else {
      // L'individu ou le groupe montré, la case qu'on inspectait s'efface.
      inspected.value = undefined;
      openSheet(picked);
    }
  };
  const controls = new CameraControls({
    element: mapElement,
    viewport: () => map.viewport,
    resolution: () => app.renderer.resolution,
    world: () => map.world,
    defaultZoom: () => openingZoom({ queryZoom, touchOnly, smallScreen: smallScreen.matches }),
    onLongPress: (mapX, mapY, screenX, screenY, finger) => {
      designate(mapX, mapY, screenX, screenY, false, finger);
    },
    onTap: (mapX, mapY, screenX, screenY, finger) => {
      designate(mapX, mapY, screenX, screenY, true, finger);
    },
    // Une apparition ne s'annule pas : outil armé, un appui long attend le relâcher, et ne
    // compte pas s'il est devenu un glisser ou un pincement (U-6).
    holdUntilRelease: () => tool.value === 'spawn',
  });
  // Fiches (IHM-02) : demandes du joueur et rafraîchissements, numérotés (app/sheets.ts).
  const sheets = new SheetRequests();
  const openSheet = (target: InspectTarget) => {
    simulation.send({ type: 'inspect', ...sheets.open(target) });
  };
  // Cases occupées, que l'outil d'apparition refuse : celles où se tient quelqu'un, à
  // l'instant affiché et à celui du dernier état reçu, et celles des apparitions envoyées
  // qu'aucun état n'a encore montrées.
  const occupied = new OccupiedCells();
  /** Instant affiché, en jours, à la dernière image. */
  let shownInstant = 0;
  /** Fait apparaître un groupe sur la case, si elle le permet ; un avis dit sinon pourquoi. */
  const spawnAt = (x: number, y: number) => {
    const info = worldInfo.value;
    if (worldLayers === undefined || info === undefined) return;
    occupied.setStanding(crowd.occupied(shownInstant, info.size));
    const target = spawnTarget(worldLayers, info.size, x, y, data, occupied);
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
    // La case est prise dès l'envoi : un second appui, avant l'image qui montrera le
    // groupe, ne l'empile pas.
    occupied.add(target.x, target.y, info.size);
  };
  /**
   * Débogage : ?crowd=2000 fait apparaître 2 000 individus dans la première partie, en pause,
   * par groupes de CROWD_GROUP autour du centre de la vue, en un carré qui tient dans sa plus
   * petite dimension (le pire cas du rendu, ADR 0014). Les sous-espèces de la première espèce
   * s'y relaient.
   */
  const crowdTotal = Math.floor(Number(query.get('crowd') ?? 0));
  let crowdSpawned = false;
  const spawnCrowd = () => {
    const info = worldInfo.value;
    const kind = creator.species.at(0);
    if (crowdSpawned || !(crowdTotal >= SPAWN_COUNT.min) || info === undefined) return;
    if (kind === undefined || worldLayers === undefined) return;
    crowdSpawned = true;
    simulation.send({ type: 'setPaused', paused: true });
    const sizes = crowdGroups(crowdTotal, CROWD_GROUP, SPAWN_COUNT);
    const { camera } = controls;
    const center = cellAt(camera.x, camera.y, info.size.width);
    // Un carré de groupes qui tient dans la plus petite dimension de la vue.
    const cellPx = TILE_PX * displayScale(camera.zoom);
    const side = Math.min(map.viewport.width, map.viewport.height) / cellPx;
    const spacing = Math.max(1, Math.floor(side / Math.ceil(Math.sqrt(sizes.length))));
    const cells = crowdCells(center, sizes.length, spacing, info.size, passable);
    cells.forEach((cell, index) => {
      const subspecies = kind.subspecies.at(index % kind.subspecies.length);
      if (subspecies === undefined) return;
      simulation.send({
        type: 'game',
        command: {
          type: 'spawnGroup',
          x: cell.x,
          y: cell.y,
          species: kind.id,
          subspecies: subspecies.id,
          count: sizes[index] ?? CROWD_GROUP,
        },
      });
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
    inspected.value = describeCell(worldLayers, info.size, x, y, clock.month(), data);
  };
  // La température du mois de la case inspectée suit le temps qui passe ; rien de plus :
  // une case inspectée n'ouvre jamais d'elle-même la fiche d'un groupe qui passe.
  const refreshInspected = () => {
    const cell = inspected.value;
    if (cell !== undefined) showCell(cell.x, cell.y);
  };
  // Chronique : les faits gardés (app/chronicle.ts), et le numéro de la dernière page demandée.
  let facts = snapshotFacts([]);
  let chronicleRequest = 0;
  /** Range les faits gardés, et montre les faits affichés et le compte des faits nouveaux. */
  const showFacts = (next: KeptFacts) => {
    facts = next;
    // Une liste figée garde sa référence : la chronique ne se redessine pas.
    chronicle.value = next.shown;
    chronicleNewFacts.value = newFacts(next);
  };
  /** Revient aux derniers faits ; une page encore en route sera ignorée. */
  const latestChronicle = () => {
    chronicleRequest++;
    chronicleLoading.value = false;
    showFacts(latestFacts(facts));
  };
  // La chronique refermée revient aux derniers faits.
  chronicleOpen.subscribe((open) => {
    if (!open) latestChronicle();
  });
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
  // Appels de dessin de chaque image, sur WebGL (débogage, ADR 0014).
  const drawCalls = new DrawCallCounter('gl' in app.renderer ? app.renderer.gl : undefined);
  let sheetRefresh = 0;
  // Au retour d'un onglet masqué, la première image couvre toute l'absence : elle ne
  // compte pas comme une image lente.
  let returning = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') returning = true;
  });
  /** Rang du jour que montre la date, pour ne la changer qu'au jour suivant. */
  let shownIndex = -1;
  // Horloge de la marche du rendu (ADR 0014) : elle n'avance qu'avec l'instant affiché, si
  // bien que les images de la marche restent figées en pause.
  let walkMs = 0;
  app.ticker.add((ticker) => {
    // La durée réelle de l'image : deltaMS est plafonné à 100 ms, et cacherait les à-coups.
    // L'image précédente a coûté ce que mesure son dessin, et ses appels de dessin.
    const calls = drawCalls.take();
    if (returning) returning = false;
    else sampler.frame(ticker.elapsedMS, { ...people.stats, drawCalls: calls });
    const now = performance.now();
    // L'instant affiché : les saisons, les individus et la date le suivent ensemble.
    const shown = clock.advance(now);
    if (shown > shownInstant) walkMs += ticker.elapsedMS;
    shownInstant = shown;
    map.setSeason(clock.month());
    crowd.show(shown);
    const today: GameTime = clock.today();
    if (dayIndex(today) !== shownIndex && time.value !== undefined) {
      shownIndex = dayIndex(today);
      shownDay.value = today;
    }
    const camera = controls.update(ticker.deltaMS);
    drawnCamera = camera;
    map.draw(camera);
    const speed = time.value?.speed ?? 'normal';
    people.draw(
      {
        source: crowd.shown,
        t: shown,
        walkMs,
        stepMs: stepDuration(SPEED_FACTORS[speed]),
        passable,
      },
      camera,
      map.viewport,
      map.world,
    );
  });
  setInterval(() => {
    const renderer = { name: app.renderer.name, resolution: app.renderer.resolution };
    debugInfo.value = {
      ...sampler.sample(performance.now()),
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
        passability = new Uint8Array(layers.biome.length);
        inspected.value = undefined;
        // Une autre partie : les réponses attendues portent sur l'ancienne, et sont ignorées.
        sheets.close();
        sheet.value = undefined;
        people.clear();
        crowd.reset(message.frame, message.time, message.world.size.width);
        sampler.receive(performance.now(), 0, positionBytes(undefined, message.frame));
        occupied.reset();
        chronicleRequest++;
        chronicleLoading.value = false;
        showFacts(snapshotFacts(message.chronicle));
        const { width } = message.world.size;
        map.setWorld(message.world, layers, (mode) => overlayTexels(mode, layers, modeData, width));
        actions.setMapMode(mapMode.value);
        const world = map.world;
        if (world !== undefined) controls.center(world);
        time.value = message.time;
        clock.reset(message.time, performance.now());
        shownIndex = dayIndex(message.time);
        shownInstant = dayIndex(message.time);
        shownDay.value = { tick: message.time.tick, day: message.time.day };
        spawnCrowd();
        break;
      }
      case 'delta': {
        map.updateChunks(message.chunks);
        // Une case repeinte change la franchissabilité, où se posent porté et bannière.
        if (message.chunks.length > 0) {
          passability.fill(0);
          people.invalidate();
        }
        // Les étapes du lot attendent leur jour ; l'image des groupes, quand elle change, vaut
        // à partir de l'instant du delta (ADR 0014).
        sampler.receive(
          performance.now(),
          message.legs?.slots.length ?? 0,
          positionBytes(message.legs, message.frame),
        );
        crowd.receive(message.time, message.legs, message.frame);
        const info = worldInfo.value;
        if (info !== undefined) occupied.update(message.chronicle, info.size);
        // Pendant la lecture des pages plus anciennes, les faits nouveaux se comptent.
        showFacts(receiveFacts(facts, message.chronicle));
        time.value = message.time;
        clock.receive(message.time, performance.now());
        break;
      }
      case 'time':
        time.value = message.time;
        clock.receive(message.time, performance.now());
        break;
      case 'stats':
        sampler.batch(message.stats);
        if (message.stats.monthMs !== undefined) clock.monthStep(message.stats.monthMs);
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
        // La fiche demandée, ou sa fermeture si sa cible n'est plus ; si le joueur demandait
        // une autre cible, qui n'est plus, la fiche en cours reste, et un avis le dit. Une
        // réponse dépassée (autre cible, autre partie, fiche fermée) ne change rien.
        const answer = sheets.receive(message);
        if (answer.type === 'shown') {
          sheet.value = answer.sheet;
          // Sur petit écran, la fiche que le joueur demande passe au-dessus à sa réponse,
          // même si elle était déjà ouverte : une cible qui n'est plus ne remonte pas la
          // fiche en cours au-dessus du panneau où il l'a demandée.
          if (answer.requested) raise('sheet');
        } else if (answer.type === 'missing') {
          if (answer.close) sheet.value = undefined;
          if (answer.notice !== undefined) showNotice(answer.notice);
        }
        break;
      }
      case 'chroniclePage':
        if (message.requestId !== chronicleRequest) break;
        chronicleLoading.value = false;
        showFacts(receivePage(facts, message.facts));
        break;
      case 'error':
        console.error(`worker : ${message.code} (${message.detail})`);
        // Une commande refusée ou écartée, comme un groupe sur une case infranchissable.
        if (message.code === 'command') {
          showNotice('command.refused');
          occupied.refused();
        }
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
      const before = olderThan(facts);
      if (before === undefined || chronicleLoading.value) return;
      // La liste affichée se fige jusqu'au retour aux derniers faits.
      showFacts(freezeFacts(facts));
      chronicleLoading.value = true;
      chronicleRequest++;
      simulation.send({ type: 'chronicle', requestId: chronicleRequest, before });
    },
    latestChronicle,
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
  // Échap qu'aucun panneau n'a pris, le focus sur la carte par exemple : il ferme le panneau
  // du dessus (ui/escape.ts).
  window.addEventListener('keydown', (event) => {
    escapeKey(event, actions);
  });

  // La poignée de main d'abord : le worker refuse tout message qui la précède.
  simulation.send({ type: 'hello', protocol: PROTOCOL_VERSION });
  // Débogage : ?stepCost=200 ajoute un coût factice de 200 ms à chaque pas mensuel.
  const stepCost = Number(query.get('stepCost') ?? 0);
  if (stepCost > 0) simulation.send({ type: 'debugStepCost', milliseconds: stepCost });
}

void main();
