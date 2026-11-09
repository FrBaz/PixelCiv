/**
 * Commandes de la caméra (IHM-07) : glisser et pincer, au doigt comme à la souris
 * (événements de pointeur), molette, flèches ou ZQSD et touches + et −. Un appui bref,
 * sans glissement, désigne un point de la carte.
 */
import {
  constrain,
  displayScale,
  pan,
  screenToMap,
  zoomAt,
  type Camera,
  type Extent,
} from './camera';

export interface ControlsOptions {
  /** Élément qui reçoit les gestes : celui de la carte. */
  readonly element: HTMLElement;
  /** Taille de l'écran, en pixels physiques. */
  readonly viewport: () => Extent;
  /** Taille du monde, en pixels de carte, ou undefined avant la partie. */
  readonly world: () => Extent | undefined;
  /** Appui bref sur la carte, au point (mapX, mapY) en pixels de carte. */
  readonly onTap: (mapX: number, mapY: number) => void;
}

/** Vitesse du déplacement au clavier, en pixels physiques par seconde. */
const KEY_SPEED = 900;
/** Facteur de zoom d'un appui sur + ou −. */
const KEY_ZOOM = 1.25;
/** Un appui reste bref s'il bouge de moins de 8 pixels CSS et dure moins de 500 ms. */
const TAP_DISTANCE = 8;
const TAP_DURATION = 500;

const KEY_DIRECTIONS: Readonly<Partial<Record<string, readonly [number, number]>>> = {
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  // Touches physiques : ZQSD sur un clavier français, WASD sur un clavier anglais.
  KeyA: [1, 0],
  KeyD: [-1, 0],
  KeyW: [0, 1],
  KeyS: [0, -1],
};

interface Point {
  readonly x: number;
  readonly y: number;
}

export class CameraControls {
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  private readonly options: ControlsOptions;
  private readonly pointers = new Map<number, Point>();
  private tap: { id: number; start: Point; time: number } | undefined;
  private readonly keys = new Set<string>();

  constructor(options: ControlsOptions) {
    this.options = options;
    const { element } = options;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => {
      this.keys.clear();
    });
  }

  /** Vise le centre du monde, à un zoom adapté à la densité de l'écran. */
  center(world: Extent): void {
    this.camera = {
      x: world.width / 2,
      y: world.height / 2,
      zoom: Math.max(1, Math.round(devicePixelRatio)),
    };
  }

  /** À chaque image : déplacement au clavier, puis retour dans le monde. */
  update(elapsedMs: number): Camera {
    let dx = 0;
    let dy = 0;
    for (const key of this.keys) {
      const direction = KEY_DIRECTIONS[key];
      if (direction !== undefined) {
        dx += direction[0];
        dy += direction[1];
      }
    }
    if (dx !== 0 || dy !== 0) {
      const distance = (KEY_SPEED * elapsedMs) / 1000;
      this.camera = pan(this.camera, dx * distance, dy * distance);
    }
    const world = this.options.world();
    if (world !== undefined) this.camera = constrain(this.camera, this.options.viewport(), world);
    return this.camera;
  }

  /** Position d'un événement dans l'élément, en pixels physiques. */
  private point(event: PointerEvent | WheelEvent): Point {
    const rect = this.options.element.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * devicePixelRatio,
      y: (event.clientY - rect.top) * devicePixelRatio,
    };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.options.element.setPointerCapture(event.pointerId);
    const point = this.point(event);
    this.pointers.set(event.pointerId, point);
    this.tap =
      this.pointers.size === 1
        ? { id: event.pointerId, start: point, time: event.timeStamp }
        : undefined;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId);
    if (previous === undefined) return;
    const point = this.point(event);
    if (this.tap !== undefined) {
      const moved = Math.hypot(point.x - this.tap.start.x, point.y - this.tap.start.y);
      if (moved > TAP_DISTANCE * devicePixelRatio) this.tap = undefined;
    }
    if (this.pointers.size === 1) {
      this.camera = pan(this.camera, point.x - previous.x, point.y - previous.y);
    } else if (this.pointers.size === 2) {
      const other = [...this.pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other !== undefined) this.pinch(previous, point, other);
    }
    this.pointers.set(event.pointerId, point);
  };

  /** Pincement : zoom autour du milieu des deux doigts, qui suit aussi leur glissement. */
  private pinch(previous: Point, point: Point, other: Point): void {
    const before = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
    const after = { x: (point.x + other.x) / 2, y: (point.y + other.y) / 2 };
    const spanBefore = Math.hypot(previous.x - other.x, previous.y - other.y);
    const spanAfter = Math.hypot(point.x - other.x, point.y - other.y);
    const moved = pan(this.camera, after.x - before.x, after.y - before.y);
    const factor = spanBefore > 0 ? spanAfter / spanBefore : 1;
    this.camera = zoomAt(moved, factor, this.options.viewport(), after.x, after.y);
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const tap = this.tap;
    this.pointers.delete(event.pointerId);
    if (tap?.id === event.pointerId && event.timeStamp - tap.time < TAP_DURATION) {
      const point = this.point(event);
      const target = screenToMap(this.camera, this.options.viewport(), point.x, point.y);
      this.options.onTap(target.x, target.y);
    }
    this.tap = undefined;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Molette en lignes ou en pages : on ramène l'écart à des pixels.
    const lines = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1 : 16;
    const factor = Math.exp(-event.deltaY * lines * 0.002);
    const point = this.point(event);
    this.camera = zoomAt(this.camera, factor, this.options.viewport(), point.x, point.y);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement) return;
    const { width, height } = this.options.viewport();
    if (event.code === 'Equal' || event.code === 'NumpadAdd') {
      this.camera = zoomAt(
        this.camera,
        this.zoomStep(1),
        this.options.viewport(),
        width / 2,
        height / 2,
      );
    } else if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
      this.camera = zoomAt(
        this.camera,
        this.zoomStep(-1),
        this.options.viewport(),
        width / 2,
        height / 2,
      );
    } else if (event.code in KEY_DIRECTIONS) {
      this.keys.add(event.code);
    }
  };

  /** Facteur d'un cran de zoom au clavier : d'un palier entier à l'autre au-delà de 1. */
  private zoomStep(direction: 1 | -1): number {
    const scale = displayScale(this.camera.zoom);
    if (scale >= 1 && (direction === 1 || scale > 1)) return (scale + direction) / this.camera.zoom;
    return direction === 1 ? KEY_ZOOM : 1 / KEY_ZOOM;
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };
}
