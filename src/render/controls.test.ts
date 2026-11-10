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
function pointer(type: string, x: number, y: number, timeStamp: number): Event {
  const event = new Event(type);
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'touch' },
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
    timeStamp: { value: timeStamp },
  });
  return event;
}

const viewport = { width: 800, height: 600 };

function setup() {
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
