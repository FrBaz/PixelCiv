/**
 * État affiché par l'interface, en signaux : le fil principal y range ce que le
 * worker lui envoie, et les composants se mettent à jour d'eux-mêmes.
 */
import { signal } from '@preact/signals';
import type { Worldgen } from '../core/data';
import type { MainMessage, TimeInfo, WorldInfo } from '../core/protocol';
import type { GenerationStage, WorldSizeId } from '../core/world';
import type { WorldParams } from '../core/worldParams';
import type { MessageKey } from '../i18n';

/** Temps de la partie, inconnu avant le premier instantané. */
export const time = signal<TimeInfo | undefined>(undefined);

/** Contenu chargé depuis data/, pour le panneau de débogage. */
export const content = signal<{ readonly biomes: number } | undefined>(undefined);

/** Monde de la partie en cours. */
export const worldInfo = signal<WorldInfo | undefined>(undefined);

/** Génération en cours : l'étape commencée, la step-ième sur steps. */
export const generation = signal<
  { readonly stage: GenerationStage; readonly step: number; readonly steps: number } | undefined
>(undefined);

/** Durée de la dernière génération de monde, en millisecondes. */
export const generationMs = signal<number | undefined>(undefined);

/** Mesures du panneau de débogage, rafraîchies quelques fois par seconde. */
export interface DebugInfo {
  readonly fps: number;
  readonly worstFrameMs: number;
  readonly stepMs: number | undefined;
  readonly worstStepMs: number | undefined;
  readonly memoryMb: number | undefined;
  /** Moteur de rendu (webgl, webgpu) et densité de pixels de l'écran. */
  readonly renderer: { readonly name: string; readonly resolution: number };
  /** Blocs de carte qui restent à cuire. */
  readonly chunks: number;
}

export const debugInfo = signal<DebugInfo | undefined>(undefined);

/** Résultat de l'auto-test du déterminisme (ADR 0003), calculé au démarrage. */
export const determinismOk = signal<boolean | undefined>(undefined);

/** Panneau de débogage ouvert ou fermé. */
export const debugOpen = signal(false);

/**
 * Avis passager à montrer au joueur, comme « Partie sauvegardée. ». Chaque avis a son
 * numéro : le même texte, montré deux fois, relance son minuteur.
 */
export const notice = signal<{ readonly key: MessageKey; readonly serial: number } | undefined>(
  undefined,
);

let noticeSerial = 0;

/** Montre un avis passager au joueur. */
export function showNotice(key: MessageKey): void {
  notice.value = { key, serial: ++noticeSerial };
}

/** Ce que l'interface peut demander au jeu. */
export interface UiActions {
  send(message: MainMessage): void;
  /** Change de mode de carte. */
  setMapMode(mode: MapModeId): void;
  save(): Promise<void>;
  load(): Promise<void>;
  exportFile(): Promise<void>;
  importFile(file: File): Promise<void>;
  /** Écran de création : l'ouvrir, le fermer, demander un aperçu, créer le monde. */
  openCreation(): void;
  closeCreation(): void;
  preview(params: WorldParams): void;
  create(params: WorldParams): void;
}

/** Ce que l'écran de création propose : bornes des paramètres, tailles, taille par défaut. */
export interface CreationSetup {
  readonly parameters: Worldgen['parameters'];
  readonly sizes: readonly WorldSizeId[];
  readonly defaultSize: WorldSizeId;
}

/** Largeur de l'aperçu de l'écran de création, en cases (paire, de 32 à 512). */
export const PREVIEW_COLUMNS = 256;

/** Écran de création ouvert. */
export const creationOpen = signal(false);

/** Monde demandé à l'écran de création, en cours de génération. */
export const creationPending = signal(false);

/** Partie chargée ou importée depuis l'écran de création, en cours de chargement. */
export const creationBusy = signal(false);

/** Aperçu de l'écran de création : ses pixels, et la clé des paramètres qui l'ont donné. */
export interface PreviewImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly key: string;
}

export const previewImage = signal<PreviewImage | undefined>(undefined);

/** Clé des paramètres d'un aperçu : tous sauf la taille, qui ne change pas les continents. */
export function previewKey(params: WorldParams): string {
  const { size: _size, ...rest } = params;
  return JSON.stringify(rest);
}

/** Modes de carte (IHM-01) : naturel, relief, biomes, ressources. */
export type MapModeId = 'natural' | 'relief' | 'biomes' | 'resources';

/** Mode de carte affiché. */
export const mapMode = signal<MapModeId>('natural');

/** Légende du mode affiché : une couleur et un nom par entrée. */
export const legendEntries = signal<
  readonly { readonly color: string; readonly label: MessageKey }[]
>([]);

/** Ce que l'inspection montre d'une case touchée (IHM-02, version de la phase 1). */
export interface CellDetails {
  readonly x: number;
  readonly y: number;
  readonly biome: MessageKey;
  readonly level: MessageKey;
  /** Altitude (m), et profondeur de l'eau (m, 0 hors de l'eau). */
  readonly elevation: number;
  readonly depth: number;
  /** Températures annuelle et du mois courant (°C). */
  readonly temperature: number;
  readonly monthly: number;
  /** Précipitations annuelles (mm par an), et celles du mois courant (mm). */
  readonly precipitation: number;
  readonly monthlyPrecipitation: number;
  /** Classe de rivière : 0 sans rivière, puis ruisseau, rivière, fleuve. */
  readonly river: number;
  readonly deposit: MessageKey | undefined;
  /** Ressources du milieu que porte le biome. */
  readonly resources: readonly MessageKey[];
  /** Densités d'arbres et de buissons, en pourcentage. */
  readonly trees: number;
  readonly shrubs: number;
}

/** Case inspectée, ou undefined. */
export const inspected = signal<CellDetails | undefined>(undefined);
