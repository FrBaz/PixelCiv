/**
 * Commandes de la caméra (IHM-07) : glisser et pincer, au doigt comme à la souris
 * (événements de pointeur, bouton principal seulement), molette, flèches ou ZQSD et
 * touches + et −. Un appui bref, sans glissement, désigne un point de la carte ; un appui
 * long, aussi, au doigt surtout, pour l'inspecter.
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
  /** Pixels physiques par pixel CSS, ceux du rendu : ils suivent le zoom du navigateur. */
  readonly resolution: () => number;
  /** Taille du monde, en pixels de carte, ou undefined avant la partie. */
  readonly world: () => Extent | undefined;
  /**
   * Appui bref sur la carte, au point (mapX, mapY) en pixels de carte, qui est le point
   * (screenX, screenY) de l'écran, en pixels physiques.
   */
  readonly onTap: (mapX: number, mapY: number, screenX: number, screenY: number) => void;
  /** Appui long, sans glissement, aux mêmes points. */
  readonly onLongPress: (mapX: number, mapY: number, screenX: number, screenY: number) => void;
  /**
   * Vrai quand un appui long doit attendre le relâcher : il ne se déclare alors que si le
   * geste n'est devenu ni un glisser ni un pincement. Sinon, il part dès que le doigt est
   * resté en place assez longtemps, comme pour inspecter une case. L'outil d'apparition
   * attend, car une apparition ne s'annule pas (U-6).
   */
  readonly holdUntilRelease?: () => boolean;
}

/** Vitesse du déplacement au clavier, en pixels physiques par seconde. */
const KEY_SPEED = 900;
/** Facteur de zoom d'un appui sur + ou −. */
const KEY_ZOOM = 1.25;
/**
 * Un appui reste bref s'il bouge de moins de 8 pixels CSS et dure moins de 500 ms ; il
 * devient long s'il reste en place au-delà.
 */
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

/**
 * Un panneau de l'interface défilera-t-il sous cette flèche ? Le navigateur fait défiler
 * le plus proche ancêtre de l'élément qui a le focus, une fiche longue par exemple, qui
 * prend le focus à son ouverture (U-14) : la carte lui laisse alors la touche.
 */
function scrollsPanel(target: EventTarget | null, vertical: boolean): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  for (let node: Element | null = target; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    const overflow = vertical ? style.overflowY : style.overflowX;
    const room = vertical
      ? node.scrollHeight > node.clientHeight
      : node.scrollWidth > node.clientWidth;
    if (room && (overflow === 'auto' || overflow === 'scroll')) return true;
  }
  return false;
}

export class CameraControls {
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  private readonly options: ControlsOptions;
  private readonly pointers = new Map<number, Point>();
  private tap: { id: number; start: Point; time: number } | undefined;
  private longPress: number | undefined;
  private readonly keys = new Set<string>();

  constructor(options: ControlsOptions) {
    this.options = options;
    const { element } = options;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    // Un geste annulé (geste du système, paume) ou une capture perdue ne vaut pas un appui.
    element.addEventListener('pointercancel', this.onPointerCancel);
    element.addEventListener('lostpointercapture', this.onPointerCancel);
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
    element.addEventListener('wheel', this.onWheel, { passive: false });
    // Un pincement au pavé tactile arrive en molette avec Ctrl : hors de la carte, sur
    // l'interface, il zoomerait la page, et l'étirerait d'un facteur quelconque.
    window.addEventListener(
      'wheel',
      (event) => {
        if (event.ctrlKey) event.preventDefault();
      },
      { passive: false },
    );
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
      zoom: Math.max(1, Math.round(this.options.resolution())),
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
    const resolution = this.options.resolution();
    return {
      x: (event.clientX - rect.left) * resolution,
      y: (event.clientY - rect.top) * resolution,
    };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // Les autres boutons de la souris restent libres pour d'autres usages.
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.options.element.setPointerCapture(event.pointerId);
    const point = this.point(event);
    this.pointers.set(event.pointerId, point);
    this.tap =
      this.pointers.size === 1
        ? { id: event.pointerId, start: point, time: event.timeStamp }
        : undefined;
    this.cancelLongPress();
    // Un appui long qui attend le relâcher n'a pas de minuteur : onPointerUp le déclare.
    if (this.tap !== undefined && this.options.holdUntilRelease?.() !== true) {
      const tap = this.tap;
      this.longPress = window.setTimeout(() => {
        this.longPress = undefined;
        if (this.tap !== tap) return;
        // L'appui long consomme le geste : le relâcher ne fera pas d'appui bref. Le point
        // visé est celui du doigt maintenant : la carte a pu le suivre de quelques pixels.
        this.tap = undefined;
        const point = this.pointers.get(tap.id) ?? tap.start;
        const target = screenToMap(this.camera, this.options.viewport(), point.x, point.y);
        this.options.onLongPress(target.x, target.y, point.x, point.y);
      }, TAP_DURATION);
    }
  };

  private cancelLongPress(): void {
    if (this.longPress !== undefined) window.clearTimeout(this.longPress);
    this.longPress = undefined;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId);
    if (previous === undefined) return;
    const point = this.point(event);
    if (this.tap !== undefined) {
      const moved = Math.hypot(point.x - this.tap.start.x, point.y - this.tap.start.y);
      if (moved > TAP_DISTANCE * this.options.resolution()) {
        this.tap = undefined;
        this.cancelLongPress();
      }
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
    if (tap?.id === event.pointerId) {
      // Un geste encore en cours est bref, ou long : son minuteur n'a pas encore sonné, ou
      // il attendait le relâcher.
      const point = this.point(event);
      const target = screenToMap(this.camera, this.options.viewport(), point.x, point.y);
      if (event.timeStamp - tap.time < TAP_DURATION) {
        this.options.onTap(target.x, target.y, point.x, point.y);
      } else {
        this.options.onLongPress(target.x, target.y, point.x, point.y);
      }
    }
    this.tap = undefined;
    this.cancelLongPress();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.tap?.id === event.pointerId) {
      this.tap = undefined;
      this.cancelLongPress();
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Molette en lignes ou en pages : on ramène l'écart à des pixels CSS.
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? 1
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : this.options.element.clientHeight;
    const delta = event.deltaY * unit;
    // Pincement au pavé tactile : Chromium l'envoie en petits écarts de pixels avec Ctrl,
    // dont la somme vaut -100 ln(facteur des doigts) ; la carte suit alors les doigts. Un
    // cran de molette vaut une centaine de pixels, ou se compte en lignes (Firefox).
    const pinch =
      event.ctrlKey && event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(delta) < 50;
    const factor = Math.exp(-delta * (pinch ? 0.01 : 0.002));
    const point = this.point(event);
    this.camera = zoomAt(this.camera, factor, this.options.viewport(), point.x, point.y);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement) return;
    // Ctrl, Cmd ou Alt : un raccourci du navigateur ou du système (Ctrl + zoome la page).
    // Sous macOS, les touches relâchées pendant Cmd ne préviennent pas : on les oublie.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      this.keys.clear();
      return;
    }
    const { width, height } = this.options.viewport();
    // Le zoom suit le caractère tapé, quelle que soit la disposition du clavier : sur un
    // clavier français, « − » est sur la touche 6.
    if (event.key === '+' || event.key === '=') {
      this.camera = zoomAt(
        this.camera,
        this.zoomStep(1),
        this.options.viewport(),
        width / 2,
        height / 2,
      );
    } else if (event.key === '-') {
      this.camera = zoomAt(
        this.camera,
        this.zoomStep(-1),
        this.options.viewport(),
        width / 2,
        height / 2,
      );
    } else if (event.code in KEY_DIRECTIONS) {
      const arrow = event.code.startsWith('Arrow');
      const vertical = event.code === 'ArrowUp' || event.code === 'ArrowDown';
      if (arrow && scrollsPanel(event.target, vertical)) return;
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
