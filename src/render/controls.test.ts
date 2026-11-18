import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ZOOM, displayScale, screenToMap, zoomLimits, type Extent } from './camera';
import { CameraControls } from './controls';

/** Un élément imité : il reçoit les écouteurs et en garde la trace. */
class FakeElement extends EventTarget {
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }

  setPointerCapture(): void {
    // Rien à capturer hors du navigateur.
  }
}

/** Un événement de pointeur, avec ce que les commandes en lisent. */
function pointer(type: string, x: number, y: number, timeStamp: number, id = 1): Event {
  const event = new Event(type);
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: 'touch' },
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
    timeStamp: { value: timeStamp },
  });
  return event;
}

const viewport = { width: 800, height: 600 };

function setup(holdUntilRelease = false) {
  const element = new FakeElement();
  const taps: { x: number; y: number }[] = [];
  const presses: { x: number; y: number }[] = [];
  const controls = new CameraControls({
    element: element as unknown as HTMLElement,
    viewport: () => viewport,
    resolution: () => 1,
    world: () => ({ width: 4096, height: 2048 }),
    defaultZoom: () => DEFAULT_ZOOM.desktop,
    onTap: (x, y) => taps.push({ x, y }),
    onLongPress: (x, y) => presses.push({ x, y }),
    holdUntilRelease: () => holdUntilRelease,
  });
  controls.camera = { x: 2048, y: 1024, zoom: 2 };
  return { element, controls, taps, presses };
}

describe('commandes de la caméra : appuis bref et long', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (handle: number) => {
        clearTimeout(handle);
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("inspecte d'un appui long la case sous le doigt, même s'il a glissé un peu", () => {
    const { element, controls, presses } = setup();
    const before = screenToMap(controls.camera, viewport, 100, 100);
    element.dispatchEvent(pointer('pointerdown', 100, 100, 0));
    // Le doigt glisse de 5 × 3 pixels, sous le seuil : la carte le suit.
    element.dispatchEvent(pointer('pointermove', 105, 103, 100));
    vi.advanceTimersByTime(500);
    expect(presses).toHaveLength(1);
    expect(presses[0]?.x).toBeCloseTo(before.x, 6);
    expect(presses[0]?.y).toBeCloseTo(before.y, 6);
  });

  it('fait un appui bref sous 500 ms, un appui long au-delà, même avant le minuteur', () => {
    const { element, taps, presses } = setup();
    element.dispatchEvent(pointer('pointerdown', 100, 100, 0));
    element.dispatchEvent(pointer('pointerup', 100, 100, 120));
    expect(taps).toHaveLength(1);
    // Relâché à 520 ms, avant que le minuteur ait sonné : c'est un appui long.
    element.dispatchEvent(pointer('pointerdown', 200, 200, 1000));
    element.dispatchEvent(pointer('pointerup', 200, 200, 1520));
    expect(presses).toHaveLength(1);
    expect(taps).toHaveLength(1);
    // Le minuteur annulé ne sonne pas une seconde fois.
    vi.advanceTimersByTime(1000);
    expect(presses).toHaveLength(1);
  });

  it("attend le relâcher, s'il le faut, et ne déclare rien d'un glisser ou d'un pincement (U-6)", () => {
    const { element, controls, taps, presses } = setup(true);
    // Le doigt reste en place 600 ms, puis la carte glisse : ni appui long ni appui bref.
    element.dispatchEvent(pointer('pointerdown', 100, 100, 0));
    vi.advanceTimersByTime(600);
    expect(presses).toHaveLength(0);
    element.dispatchEvent(pointer('pointermove', 140, 100, 650));
    element.dispatchEvent(pointer('pointerup', 140, 100, 700));
    // Un second doigt arrive 550 ms après le premier : un pincement, sans appui.
    element.dispatchEvent(pointer('pointerdown', 300, 300, 1000));
    vi.advanceTimersByTime(550);
    element.dispatchEvent(pointer('pointerdown', 340, 340, 1550, 2));
    element.dispatchEvent(pointer('pointermove', 360, 360, 1600, 2));
    element.dispatchEvent(pointer('pointerup', 300, 300, 1700));
    element.dispatchEvent(pointer('pointerup', 360, 360, 1710, 2));
    vi.advanceTimersByTime(1000);
    expect(taps).toHaveLength(0);
    expect(presses).toHaveLength(0);
    // Le doigt reste en place, puis se lève sans avoir glissé : l'appui long se déclare
    // alors, au point du relâcher, et une seule fois.
    const target = screenToMap(controls.camera, viewport, 200, 200);
    element.dispatchEvent(pointer('pointerdown', 200, 200, 3000));
    vi.advanceTimersByTime(800);
    expect(presses).toHaveLength(0);
    element.dispatchEvent(pointer('pointerup', 200, 200, 3800));
    vi.advanceTimersByTime(1000);
    expect(presses).toEqual([target]);
    expect(taps).toHaveLength(0);
  });

  it("n'appuie pas quand le doigt glisse au-delà du seuil", () => {
    const { element, taps, presses } = setup();
    element.dispatchEvent(pointer('pointerdown', 100, 100, 0));
    element.dispatchEvent(pointer('pointermove', 130, 100, 50));
    vi.advanceTimersByTime(600);
    element.dispatchEvent(pointer('pointerup', 130, 100, 700));
    expect(taps).toHaveLength(0);
    expect(presses).toHaveLength(0);
  });
});

/**
 * Un élément de la page imité, pour l'aiguillage des flèches : son parent, les sélecteurs
 * auxquels il répond, son défilement et son style.
 */
class FakeNode {
  readonly parentElement: FakeNode | null;
  readonly selectors: readonly string[];
  readonly style: { readonly overflowX: string; readonly overflowY: string };
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  /** Correspond-il à :focus-visible ? */
  focusVisible = false;

  constructor(
    parent: FakeNode | null,
    options: {
      selectors?: readonly string[];
      overflowX?: string;
      overflowY?: string;
      width?: readonly [number, number];
      height?: readonly [number, number];
    } = {},
  ) {
    this.parentElement = parent;
    this.selectors = options.selectors ?? [];
    this.style = {
      overflowX: options.overflowX ?? 'visible',
      overflowY: options.overflowY ?? 'visible',
    };
    [this.scrollWidth, this.clientWidth] = options.width ?? [100, 100];
    [this.scrollHeight, this.clientHeight] = options.height ?? [100, 100];
  }

  matches(selector: string): boolean {
    return selector === ':focus-visible' ? this.focusVisible : this.selectors.includes(selector);
  }

  closest(selector: string): FakeNode | null {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null);
  }
}

/** Un champ de saisie imité : la classe que la fenêtre connaît pour HTMLInputElement. */
class FakeInput {
  readonly value = '';
}

/**
 * La page : une fiche qui déborde en hauteur, la barre du bas qui déborde en largeur, comme
 * sur petit écran, et l'écran de création, dialogue modal qui déborde lui aussi.
 */
function page() {
  const body = new FakeNode(null, { overflowX: 'hidden', overflowY: 'hidden' });
  const sheet = new FakeNode(body, {
    selectors: ['.sheet'],
    overflowY: 'auto',
    height: [1060, 640],
  });
  const title = new FakeNode(sheet);
  const actions = new FakeNode(body, {
    selectors: ['.hud-actions'],
    overflowX: 'auto',
    width: [1113, 936],
  });
  const relief = new FakeNode(actions);
  const creation = new FakeNode(body, {
    selectors: ['[aria-modal="true"]'],
    overflowY: 'auto',
    height: [900, 500],
  });
  return { body, title, relief, creation };
}

describe('commandes de la caméra : flèches, à la carte ou au panneau (U-14)', () => {
  const listeners = new Map<string, (event: unknown) => void>();

  beforeEach(() => {
    listeners.clear();
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
    });
    vi.stubGlobal('Element', FakeNode);
    vi.stubGlobal('HTMLInputElement', FakeInput);
    vi.stubGlobal('getComputedStyle', (node: FakeNode) => node.style);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Les commandes, et ce que fait une touche : la carte bouge-t-elle, le défilement est-il empêché ? */
  function keys() {
    const { controls } = setup();
    const focus = (target: FakeNode) => {
      listeners.get('focusin')?.({ target });
    };
    const press = (target: FakeNode, code: string) => {
      const before = controls.camera;
      const event = { code, key: code, target, preventDefault: vi.fn() };
      listeners.get('keydown')?.(event);
      controls.update(100);
      listeners.get('keyup')?.(event);
      const moved = controls.camera.x !== before.x || controls.camera.y !== before.y;
      return { moved, prevented: event.preventDefault.mock.calls.length > 0 };
    };
    return { focus, press };
  }

  it('restent à la carte après un clic, même quand la touche rend le focus visible', () => {
    const { body, title } = page();
    const { focus, press } = keys();
    // Une fiche ouverte d'un clic sur un groupe : son titre a le focus, sans :focus-visible.
    focus(title);
    // Dans Chromium, la touche pressée rend visible le focus, avant même son keydown.
    title.focusVisible = true;
    expect(press(title, 'ArrowDown')).toEqual({ moved: true, prevented: true });
    expect(press(title, 'KeyS')).toEqual({ moved: true, prevented: false });
    // Le focus sur le corps de la page, après un clic sur la carte : la carte aussi.
    expect(press(body, 'ArrowUp')).toEqual({ moved: true, prevented: true });
  });

  it('vont à la fiche où le joueur navigue au clavier, dans le sens où elle défile', () => {
    const { title } = page();
    const { focus, press } = keys();
    title.focusVisible = true;
    focus(title);
    expect(press(title, 'ArrowDown')).toEqual({ moved: false, prevented: false });
    // La fiche ne défile pas en largeur : la flèche droite reste à la carte.
    expect(press(title, 'ArrowRight')).toEqual({ moved: true, prevented: true });
  });

  it('ne vont jamais à la barre du bas, même au clavier (U-3)', () => {
    const { relief } = page();
    const { focus, press } = keys();
    relief.focusVisible = true;
    focus(relief);
    expect(press(relief, 'ArrowRight')).toEqual({ moved: true, prevented: true });
  });

  it("vont à l'écran de création qui défile, même ouvert à la souris : il recouvre la carte", () => {
    const { creation } = page();
    const { focus, press } = keys();
    focus(creation);
    expect(press(creation, 'ArrowDown')).toEqual({ moved: false, prevented: false });
  });
});

describe('commandes de la caméra : zoom (2b.1)', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  /** Un monde Petit, en pixels de carte. */
  const world = { width: 2048, height: 1024 };

  beforeEach(() => {
    listeners.clear();
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
    });
    vi.stubGlobal('HTMLInputElement', FakeInput);
    vi.stubGlobal('WheelEvent', { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Les commandes d'une partie qui s'ouvre au zoom `defaultZoom`, en pixels CSS par pixel de
   * carte, dans un monde de `extent` pixels de carte, Petit par défaut, sur un écran qui peut
   * changer d'une image à l'autre : `screen` en donne la taille, en pixels physiques, et la
   * densité. `key` tape une touche, `wheel` tourne la molette de `deltaY` pixels ; chacun
   * passe une image et rend l'échelle affichée.
   */
  function zoomControls(
    screen: { viewport: Extent; resolution: number },
    defaultZoom = 2,
    extent: Extent = world,
  ) {
    const element = new FakeElement();
    const controls = new CameraControls({
      element: element as unknown as HTMLElement,
      viewport: () => screen.viewport,
      resolution: () => screen.resolution,
      world: () => extent,
      defaultZoom: () => defaultZoom,
      onTap: () => undefined,
      onLongPress: () => undefined,
      holdUntilRelease: () => true,
    });
    controls.center(extent);
    controls.update(16);
    const key = (name: string): number => {
      listeners.get('keydown')?.({ key: name, code: '', target: null, preventDefault: vi.fn() });
      controls.update(16);
      return displayScale(controls.camera.zoom);
    };
    const wheel = (deltaY: number): number => {
      const event = new Event('wheel');
      Object.defineProperties(event, {
        deltaY: { value: deltaY },
        deltaMode: { value: 0 },
        ctrlKey: { value: false },
        clientX: { value: 400 },
        clientY: { value: 300 },
      });
      element.dispatchEvent(event);
      controls.update(16);
      return displayScale(controls.camera.zoom);
    };
    return { element, controls, key, wheel };
  }

  /** Un écran de 1 280 × 720 pixels CSS, en pixels physiques à la densité `resolution`. */
  function pc(resolution: number): Extent {
    return { width: Math.round(1280 * resolution), height: Math.round(720 * resolution) };
  }

  it('convertit le zoom par défaut, 2 ou 3 pixels CSS par pixel de carte, au palier de la densité', () => {
    // Densité, puis zooms 2 et 3 en pixels physiques par pixel de carte : à la densité 2,75,
    // 5,5 donne 6, et 8,25 donne 8.
    const cases = [
      [1, 2, 3],
      [1.25, 3, 4],
      [1.5, 3, 5],
      [2, 4, 6],
      [2.625, 5, 8],
      [2.75, 6, 8],
      [3, 6, 9],
    ] as const;
    for (const [resolution, desktop, phone] of cases) {
      const screen = { viewport: pc(resolution), resolution };
      expect(zoomControls(screen, DEFAULT_ZOOM.desktop).controls.camera.zoom).toBe(desktop);
      expect(zoomControls(screen, DEFAULT_ZOOM.phone).controls.camera.zoom).toBe(phone);
    }
  });

  it('ramène le zoom par défaut entre les bornes', () => {
    // 2 100 pixels de haut pour un monde de 1 024 : le palier 3 remplit la hauteur.
    const tall = { viewport: { width: 1000, height: 2100 }, resolution: 1 };
    expect(zoomControls(tall).controls.camera.zoom).toBe(3);
    // ?zoom=100 : au plus 24 pixels CSS ; ?zoom=0.25 : au moins l'échelle qui remplit.
    const dense = { viewport: pc(2), resolution: 2 };
    expect(zoomControls(dense, 100).controls.camera.zoom).toBe(48);
    const plain = { viewport: pc(1), resolution: 1 };
    expect(zoomControls(plain, 0.25).controls.camera.zoom).toBe(720 / 1024);
  });

  it("monte au clavier jusqu'à 24 pixels CSS par pixel de carte, puis redescend au plus faible", () => {
    const steps = [
      { resolution: 1, up: [2, 3, 4, 5, 6, 8, 10, 13, 16, 20, 24] },
      { resolution: 2.75, up: [6, 8, 10, 13, 16, 20, 25, 31, 39, 49, 61, 66] },
    ];
    for (const { resolution, up } of steps) {
      const viewport = pc(resolution);
      const { min, max } = zoomLimits(viewport, world, resolution);
      expect(max / resolution).toBe(24);
      const { controls, key } = zoomControls({ viewport, resolution });
      // Chaque cran change l'image, d'un palier entier au moins, jusqu'au maximum.
      const scales = [displayScale(controls.camera.zoom)];
      while (scales.length < up.length) scales.push(key('+'));
      expect(scales).toEqual(up);
      expect(key('+')).toBe(max);
      // Puis chaque cran redescend, jusqu'au zoom le plus faible, où il s'arrête.
      const down = [max];
      while (down.at(-1) !== min && down.length < 40) down.push(key('-'));
      expect(down.at(-1)).toBe(min);
      for (let index = 1; index < down.length; index++) {
        expect(down[index]).toBeLessThan(down[index - 1] ?? 0);
      }
      expect(key('-')).toBe(min);
    }
  });

  it("change l'image à chaque cran du clavier, même si la molette a laissé le zoom entre deux paliers", () => {
    const { controls, key } = zoomControls({ viewport: pc(1), resolution: 1 });
    // 1,4 s'affiche à l'échelle 1 : un cran vers l'arrière passe sous 1, et non à 1,12, qui
    // s'afficherait encore à l'échelle 1.
    controls.camera = { ...controls.camera, zoom: 1.4 };
    expect(key('-')).toBeCloseTo(0.8, 9);
    controls.camera = { ...controls.camera, zoom: 2.4 };
    expect(key('+')).toBe(3);
    controls.camera = { ...controls.camera, zoom: 2.4 };
    expect(key('-')).toBe(1);
  });

  it("fixe exactement l'échelle visée au clavier, même après la molette", () => {
    const { controls, key, wheel } = zoomControls({ viewport: pc(1), resolution: 1 });
    // 7 pixels de molette laissent le zoom à 1,972, affiché à l'échelle 2. Le cran − fixe
    // l'échelle 1, au lieu de la reconstituer par le facteur 1 / 1,972, qui laissait
    // 0,9999999999999999 : une échelle continue, donc la vue lointaine, à l'échelle 1, puis
    // un cran + sans effet, à 1,2499999999999998.
    expect(wheel(7)).toBe(2);
    expect(controls.camera.zoom).toBeCloseTo(1.9722, 4);
    key('-');
    expect(controls.camera.zoom).toBe(1);
    key('+');
    expect(controls.camera.zoom).toBe(2);
    // Tous les zooms affichés à l'échelle 2 que la molette laisse depuis le zoom 2, de 1,5 à
    // 2,5 : 2 e^(−0,002 k).
    const misses: number[] = [];
    for (let k = -111; k <= 143; k++) {
      controls.camera = { ...controls.camera, zoom: 2 };
      if (wheel(k) !== 2) throw new Error(`molette de ${String(k)} pixels hors de l'échelle 2`);
      key('-');
      if (controls.camera.zoom !== 1) misses.push(k);
    }
    expect(misses).toEqual([]);
  });

  it("s'arrête aux mêmes bornes à la molette et au pincement", () => {
    const { element, controls, wheel } = zoomControls({ viewport: pc(1), resolution: 1 });
    const scales = Array.from({ length: 60 }, () => wheel(-100));
    expect(Math.max(...scales)).toBe(24);
    expect(scales.at(-1)).toBe(24);
    expect(Array.from({ length: 60 }, () => wheel(100)).at(-1)).toBe(720 / 1024);
    // Deux doigts à 2 pixels l'un de l'autre s'écartent de 401, puis se rapprochent à 1.
    element.dispatchEvent(pointer('pointerdown', 399, 300, 0, 1));
    element.dispatchEvent(pointer('pointerdown', 401, 300, 10, 2));
    element.dispatchEvent(pointer('pointermove', 800, 300, 20, 2));
    controls.update(16);
    expect(controls.camera.zoom).toBe(24);
    element.dispatchEvent(pointer('pointermove', 400, 300, 30, 2));
    controls.update(16);
    expect(controls.camera.zoom).toBe(720 / 1024);
  });

  it("recalcule les bornes quand l'écran change entre deux images, sans écraser le zoom demandé", () => {
    const screen = { viewport: pc(1), resolution: 1 };
    const { controls, key } = zoomControls(screen);
    // Au plus faible en 1 280 × 720, la carte remplit la hauteur à l'échelle 0,703125.
    let scale = 0;
    for (let press = 0; press < 20; press++) scale = key('-');
    expect(scale).toBe(720 / 1024);
    // La fenêtre passe en 1 920 × 1 080 : dès l'image suivante, le palier 2 la remplit, et
    // un cran − n'y change rien.
    screen.viewport = { width: 1920, height: 1080 };
    controls.update(16);
    expect(controls.camera.zoom).toBe(2);
    expect(key('-')).toBe(2);
    // Retour en 1 280 × 720 : le zoom demandé revient, celui d'avant le redimensionnement.
    screen.viewport = pc(1);
    controls.update(16);
    expect(controls.camera.zoom).toBe(720 / 1024);
    // Le zoom du navigateur double la densité : le maximum passe à 48 pixels physiques,
    // toujours 24 pixels CSS, puis retombe à 24 quand la densité revient à 1.
    Object.assign(screen, { viewport: pc(2), resolution: 2 });
    for (let press = 0; press < 30; press++) scale = key('+');
    expect(scale).toBe(48);
    Object.assign(screen, { viewport: pc(1), resolution: 1 });
    controls.update(16);
    expect(controls.camera.zoom).toBe(24);
    // À la densité 0,5, le maximum tombe à 12 pixels physiques ; de retour à la densité 1,
    // le zoom remonte à 24.
    Object.assign(screen, { viewport: pc(0.5), resolution: 0.5 });
    controls.update(16);
    expect(controls.camera.zoom).toBe(12);
    Object.assign(screen, { viewport: pc(1), resolution: 1 });
    controls.update(16);
    expect(controls.camera.zoom).toBe(24);
  });

  it('rend le zoom demandé quand le téléphone revient du portrait au paysage', () => {
    // Pixel 5, de densité 2,75, et monde Moyen, de 1 536 pixels de carte de haut : 2 206 × 806
    // pixels physiques en paysage, et 1 080 × 1 999 en portrait.
    const medium = { width: 3072, height: 1536 };
    const landscape = { width: 2206, height: 806 };
    const portrait = { width: 1080, height: 1999 };
    const screen = { viewport: landscape, resolution: 2.75 };
    const { controls, key, wheel } = zoomControls(screen, DEFAULT_ZOOM.phone, medium);
    // Au plus faible en paysage, tout le monde, à l'échelle 806 / 1 536.
    for (let press = 0; press < 20; press++) key('-');
    expect(controls.camera.zoom).toBe(806 / 1536);
    // En portrait, le palier 2 remplit la hauteur ; un cran −, ou une molette sans écart, ne
    // change rien, et ne touche donc pas au zoom demandé.
    screen.viewport = portrait;
    controls.update(16);
    expect(controls.camera.zoom).toBe(2);
    expect(key('-')).toBe(2);
    expect(wheel(0)).toBe(2);
    // De retour en paysage, le zoom d'avant la rotation.
    screen.viewport = landscape;
    controls.update(16);
    expect(controls.camera.zoom).toBe(806 / 1536);
    // Un zoom choisi en portrait part du zoom affiché, sans zone morte : le palier 3, gardé
    // en paysage, puis de nouveau en portrait.
    screen.viewport = portrait;
    controls.update(16);
    expect(key('+')).toBe(3);
    screen.viewport = landscape;
    controls.update(16);
    expect(controls.camera.zoom).toBe(3);
    screen.viewport = portrait;
    controls.update(16);
    expect(controls.camera.zoom).toBe(3);
  });

  it('suit la rotation du téléphone, qui est un redimensionnement', () => {
    // Pixel 5, de densité 2,75 : 1 080 × 2 340 pixels physiques en portrait.
    const screen = { viewport: { width: 1080, height: 2340 }, resolution: 2.75 };
    const { controls, key } = zoomControls(screen, DEFAULT_ZOOM.phone);
    expect(controls.camera.zoom).toBe(8);
    let scale = 0;
    for (let press = 0; press < 20; press++) scale = key('-');
    expect(scale).toBe(3);
    // En paysage, 1 080 pixels de haut : le palier 2 remplit la hauteur.
    screen.viewport = { width: 2340, height: 1080 };
    controls.update(16);
    for (let press = 0; press < 20; press++) scale = key('-');
    expect(scale).toBe(2);
    // De retour en portrait, le zoom remonte aussitôt au palier 3.
    screen.viewport = { width: 1080, height: 2340 };
    controls.update(16);
    expect(controls.camera.zoom).toBe(3);
  });
});
