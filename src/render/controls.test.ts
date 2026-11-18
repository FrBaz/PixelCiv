import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screenToMap } from './camera';
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
