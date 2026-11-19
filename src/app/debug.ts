/**
 * Mesures du panneau de débogage (NF-01, ADR 0013, ADR 0014, ADR 0015) : tics de l'animation
 * par seconde, images dessinées parmi eux (rendu à la demande) et tic le plus long, sur la
 * dernière seconde ; durée moyenne d'un jour sur les mille derniers au moins ; durée moyenne
 * du pas mensuel et le plus long sur les douze derniers ; jours par lot sur les trente derniers
 * lots ; marcheurs au dernier lot ; positions reçues par seconde, étapes et octets ; ce que
 * coûte une image au fil principal, en moyenne sur la dernière seconde : sa mise à jour, par
 * tic, et son rendu par PixiJS, par image dessinée, la chronologie des individus, à
 * l'affichage et à la réception des messages, et le dessin des individus (positions, tri,
 * sprites) ; ce que l'image dessine : sprites, textures, appels de dessin. Ces dernières
 * mesures ne dépendent pas du GPU : dans un navigateur qui rend en logiciel, les images par
 * seconde ne disent rien de lui.
 */
import { GROUP_STRIDE, type GroupsFrame, type LegArrays, type StepStats } from '../core/protocol';

export interface DebugSample {
  /**
   * Tics de l'animation par seconde, sur la dernière seconde : chacun met l'image à jour, sans
   * forcément la dessiner (rendu à la demande).
   */
  readonly fps: number;
  /**
   * Images dessinées par seconde, sur la dernière seconde : le rendu à la demande ne dessine
   * que celles qui changent (ADR 0010, tâche 2b.4).
   */
  readonly drawnFps: number;
  /** Plus long intervalle entre deux tics de la dernière seconde, en millisecondes. */
  readonly worstFrameMs: number;
  /** Durée moyenne d'un jour ordinaire, hors pas mensuel, en millisecondes. */
  readonly dayMs: number | undefined;
  /** Durée moyenne et plus longue des derniers pas mensuels, en millisecondes. */
  readonly monthMs: number | undefined;
  readonly worstMonthMs: number | undefined;
  /** Jours par lot, en moyenne sur les derniers lots. */
  readonly batchDays: number | undefined;
  /** Marcheurs à la fin du dernier lot (ADR 0014). */
  readonly walkers: number | undefined;
  /** Étapes et octets de positions (étapes et images des groupes) reçus par seconde. */
  readonly legsPerSecond: number | undefined;
  readonly positionBytesPerSecond: number | undefined;
  /**
   * Durées moyennes sur la dernière seconde, en millisecondes : la mise à jour, par tic (le
   * rappel de l'image : horloge, chronologie, carte, individus), et le rendu par PixiJS, qui
   * la suit, par image dessinée. En marche, chaque tic se dessine, et leur somme est ce que
   * l'image coûte au fil principal, hors messages ; en pause, elles portent sur des tics
   * différents.
   */
  readonly main: { readonly update: number; readonly render: number };
  /**
   * Durée moyenne, par image, de l'instant affiché de la chronologie des individus, compris
   * dans la mise à jour, et des messages qu'elle reçoit d'une image à l'autre.
   */
  readonly timeline: { readonly show: number; readonly receive: number };
  /**
   * Durée moyenne, par image, des positions et de la disposition des individus, de leur tri
   * et de la mise à jour des sprites, comprises dans la mise à jour.
   */
  readonly crowd: { readonly positions: number; readonly sort: number; readonly sprites: number };
  /**
   * À la dernière image : sprites dessinés, textures distinctes et gardées, pages de l'atlas
   * dynamique, appels de dessin.
   */
  readonly drawn: number | undefined;
  readonly textures: number | undefined;
  readonly cachedTextures: number | undefined;
  readonly pages: number | undefined;
  readonly drawCalls: number | undefined;
}

/**
 * Ce que coûte et dessine une image, pour le panneau : le dessin des individus
 * (render/people.ts, PeopleStats) et, s'ils se mesurent, sa mise à jour, son rendu et la
 * chronologie (app/main.ts), en millisecondes.
 */
export interface FrameCost {
  readonly positionsMs: number;
  readonly sortMs: number;
  readonly spritesMs: number;
  readonly drawn: number;
  readonly textures: number;
  readonly cached: number;
  /** Pages de l'atlas dynamique des textures (render/pages.ts). */
  readonly pages: number;
  /** Appels de dessin de l'image, s'ils se comptent (DrawCallCounter). */
  readonly drawCalls?: number;
  /** Le rappel de l'image, et le rendu de la scène par PixiJS qui le suit. */
  readonly updateMs?: number;
  readonly renderMs?: number;
  /** L'image a-t-elle été dessinée (rendu à la demande) ? Sans réponse, elle l'a été. */
  readonly rendered?: boolean;
  /** L'instant affiché de la chronologie, et les messages qu'elle a reçus depuis l'image d'avant. */
  readonly showMs?: number;
  readonly receiveMs?: number;
}

/** Octets d'une étape dans un message (ADR 0014) : emplacement, jour, départ, pas, jours. */
export const LEG_BYTES = 4 + 4 + 8 + 8 + 2;
/** Octets d'un membre dans l'image des groupes : emplacement, identifiant, apparence, stature, position, porteur. */
export const MEMBER_BYTES = 4 + 4 + 2 + 1 + 8 + 4;

/** Octets de positions d'un delta ou d'un instantané : ses étapes, et son image s'il en porte une. */
export function positionBytes(legs: LegArrays | undefined, frame: GroupsFrame | undefined): number {
  const legCount = (legs?.slots.length ?? 0) + (frame?.legs.slots.length ?? 0);
  const groups = frame === undefined ? 0 : frame.groups.length / GROUP_STRIDE;
  return legCount * LEG_BYTES + (frame?.ids.length ?? 0) * MEMBER_BYTES + groups * GROUP_STRIDE * 4;
}

/**
 * Jours ordinaires gardés pour leur moyenne, au moins. Hors isolement cross-origin,
 * l'horloge d'un worker n'avance que par pas de 0,1 ms : un jour de quelques microsecondes
 * s'y mesure 0 ou 0,1 ms, et seule une moyenne sur un millier de jours en approche la durée.
 */
export const DAY_WINDOW = 1000;
/** Pas mensuels et lots gardés pour les moyennes. */
const MONTH_WINDOW = 12;
const BATCH_WINDOW = 30;
/** Fenêtre des images, en millisecondes. */
const FRAME_WINDOW_MS = 1000;

const mean = (values: readonly number[]) =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

/** Ajoute une valeur au bout d'une fenêtre, qui ne garde que les `size` dernières. */
function keep(values: number[], value: number, size: number): void {
  values.push(value);
  if (values.length > size) values.splice(0, values.length - size);
}

/** Fenêtre des positions reçues, en millisecondes. */
const RECEIVED_WINDOW_MS = 1000;

export class DebugSampler {
  private frames: number[] = [];
  /** Coût de chaque image de la fenêtre, dans l'ordre de `frames`. */
  private costs: (FrameCost | undefined)[] = [];
  /** Positions reçues : instant (ms), étapes, octets. */
  private received: { readonly at: number; readonly legs: number; readonly bytes: number }[] = [];
  /** Durée totale des jours ordinaires de chacun des derniers lots, et leur nombre. */
  private days: { readonly total: number; readonly count: number }[] = [];
  private dayCount = 0;
  private months: number[] = [];
  private batches: number[] = [];
  private walkers: number | undefined;

  /** Enregistre la durée d'une image, et ce qu'y ont coûté les individus. */
  frame(durationMs: number, cost?: FrameCost): void {
    this.frames.push(durationMs);
    this.costs.push(cost);
    let total = this.frames.reduce((sum, duration) => sum + duration, 0);
    while (this.frames.length > 1 && total - (this.frames[0] ?? 0) >= FRAME_WINDOW_MS) {
      total -= this.frames.shift() ?? 0;
      this.costs.shift();
    }
  }

  /** Des positions reçues à l'instant `at` (ms) : `legs` étapes, `bytes` octets en tout. */
  receive(at: number, legs: number, bytes: number): void {
    this.received.push({ at, legs, bytes });
    while ((this.received[0]?.at ?? at) <= at - RECEIVED_WINDOW_MS) this.received.shift();
  }

  /** Enregistre les mesures d'un lot de jours du worker. */
  batch(stats: StepStats): void {
    const ordinary = stats.days - (stats.monthMs === undefined ? 0 : 1);
    if (stats.dayMs !== undefined && ordinary > 0) {
      this.days.push({ total: stats.dayMs * ordinary, count: ordinary });
      this.dayCount += ordinary;
      // Les lots les plus anciens s'oublient, tant qu'il reste DAY_WINDOW jours sans eux.
      let first = this.days.at(0);
      while (first !== undefined && this.dayCount - first.count >= DAY_WINDOW) {
        this.days.shift();
        this.dayCount -= first.count;
        first = this.days.at(0);
      }
    }
    if (stats.monthMs !== undefined) keep(this.months, stats.monthMs, MONTH_WINDOW);
    if (stats.days > 0) keep(this.batches, stats.days, BATCH_WINDOW);
    this.walkers = stats.walkers;
  }

  /** Les mesures ; `now` (ms) date les positions reçues, comptées sur la dernière seconde. */
  sample(now?: number): DebugSample {
    const total = this.frames.reduce((sum, duration) => sum + duration, 0);
    const costs = this.costs.filter((cost): cost is FrameCost => cost !== undefined);
    const average = (pick: (cost: FrameCost) => number, of = costs) =>
      of.length === 0 ? 0 : of.reduce((sum, cost) => sum + pick(cost), 0) / of.length;
    // Le rendu et ce qu'il dessine se lisent sur les images dessinées.
    const rendered = costs.filter((cost) => cost.rendered !== false);
    const last = rendered.at(-1) ?? costs.at(-1);
    const recent =
      now === undefined ? undefined : this.received.filter((entry) => entry.at > now - 1000);
    const undrawn = this.costs.filter((cost) => cost?.rendered === false).length;
    return {
      fps: total > 0 ? (this.frames.length * 1000) / total : 0,
      drawnFps: total > 0 ? ((this.frames.length - undrawn) * 1000) / total : 0,
      worstFrameMs: Math.max(0, ...this.frames),
      dayMs:
        this.dayCount > 0
          ? this.days.reduce((sum, batch) => sum + batch.total, 0) / this.dayCount
          : undefined,
      monthMs: mean(this.months),
      worstMonthMs: this.months.length > 0 ? Math.max(...this.months) : undefined,
      batchDays: mean(this.batches),
      walkers: this.walkers,
      legsPerSecond: recent?.reduce((sum, entry) => sum + entry.legs, 0),
      positionBytesPerSecond: recent?.reduce((sum, entry) => sum + entry.bytes, 0),
      main: {
        update: average((cost) => cost.updateMs ?? 0),
        render: average((cost) => cost.renderMs ?? 0, rendered),
      },
      timeline: {
        show: average((cost) => cost.showMs ?? 0),
        receive: average((cost) => cost.receiveMs ?? 0),
      },
      crowd: {
        positions: average((cost) => cost.positionsMs),
        sort: average((cost) => cost.sortMs),
        sprites: average((cost) => cost.spritesMs),
      },
      drawn: last?.drawn,
      textures: last?.textures,
      cachedTextures: last?.cached,
      pages: last?.pages,
      drawCalls: last?.drawCalls,
    };
  }
}

/**
 * Réglages de débogage de l'affichage, tirés de l'adresse (ADR 0015) : `?waves=off` éteint la
 * mer animée ; `?waveStep=N` fixe son pas, un entier positif ou nul, pour des captures qui se
 * comparent à son miroir ; `?month=N` fixe le mois continu, de 0 à 12, que montre la carte,
 * saisons et gel de l'onde compris (la date et la simulation n'en savent rien).
 */
export interface DisplayOverrides {
  readonly waves: boolean;
  readonly waveStep: number | undefined;
  readonly month: number | undefined;
}

export function displayOverrides(query: URLSearchParams): DisplayOverrides {
  const number = (name: string) => {
    const text = query.get(name)?.trim() ?? '';
    return text === '' ? Number.NaN : Number(text);
  };
  const step = number('waveStep');
  const month = number('month');
  return {
    waves: query.get('waves') !== 'off',
    waveStep: Number.isSafeInteger(step) && step >= 0 ? step : undefined,
    month: Number.isFinite(month) && month >= 0 && month <= 12 ? month : undefined,
  };
}

/** Mémoire occupée par le tas JavaScript, en mégaoctets, si le navigateur la donne. */
export function usedMemoryMb(): number | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const bytes = memory?.usedJSHeapSize;
  return typeof bytes === 'number' ? bytes / (1024 * 1024) : undefined;
}

/** Ce qu'un contexte WebGL sait dessiner : les appels que compte DrawCallCounter. */
interface DrawingContext {
  drawElements: (...args: never[]) => void;
  drawArrays: (...args: never[]) => void;
}

/**
 * Compte les appels de dessin WebGL de chaque image (débogage) : chacun passe par
 * drawElements ou drawArrays, que le compteur enveloppe une fois pour toutes.
 */
export class DrawCallCounter {
  private count = 0;

  constructor(gl: DrawingContext | undefined) {
    if (gl === undefined) return;
    const elements = gl.drawElements.bind(gl);
    const arrays = gl.drawArrays.bind(gl);
    gl.drawElements = (...args) => {
      this.count++;
      elements(...args);
    };
    gl.drawArrays = (...args) => {
      this.count++;
      arrays(...args);
    };
  }

  /** Les appels depuis le dernier relevé : ceux de l'image rendue entre deux. */
  take(): number {
    const count = this.count;
    this.count = 0;
    return count;
  }
}
