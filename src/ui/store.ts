/**
 * État affiché par l'interface, en signaux : le fil principal y range ce que le
 * worker lui envoie, et les composants se mettent à jour d'eux-mêmes.
 */
import { signal } from '@preact/signals';
import type { Species, Worldgen } from '../core/data';
import type {
  ChronicleView,
  GroupView,
  MainMessage,
  PersonView,
  TimeInfo,
  WorldInfo,
} from '../core/protocol';
import type { GenerationStage, WorldSizeId } from '../core/world';
import type { WorldParams } from '../core/worldParams';
import type { MessageKey } from '../i18n';
import type { SidePanel } from './panels';

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
  /** Ouvre la fiche d'un individu ou d'un groupe (IHM-02), ou la referme. */
  inspectPerson(id: number): void;
  inspectGroup(id: number): void;
  closeSheet(): void;
  /** Demande au worker la page de faits de la chronique qui précède les faits gardés. */
  olderChronicle(): void;
  /** Centre la carte sur une case. */
  focus(x: number, y: number): void;
}

/**
 * Demandes du joueur de voir un panneau de la colonne, numérotées : chacune remet le
 * panneau au-dessus des autres sur petit écran (panels.ts), même s'il montrait déjà la même
 * chose, comme un fait de la chronique touché deux fois.
 */
export const raised = signal<Readonly<Partial<Record<SidePanel, number>>>>({});

export function raise(panel: SidePanel): void {
  raised.value = { ...raised.value, [panel]: (raised.value[panel] ?? 0) + 1 };
}

/**
 * Le panneau est-il ouvert mais caché sous un autre, sur petit écran ? Son bouton le
 * remonte alors, au lieu de le fermer.
 */
export function buried(panel: Element | null): boolean {
  return panel !== null && panel.getClientRects().length === 0;
}

/** Outil de la carte : inspecter (appui, clic), ou faire apparaître un groupe (CRE-03). */
export type Tool = 'inspect' | 'spawn';
export const tool = signal<Tool>('inspect');

/** Réglages de l'outil d'apparition : l'espèce, la sous-espèce et le nombre de personnes. */
export interface SpawnSettings {
  readonly species: string;
  readonly subspecies: string;
  readonly count: number;
}

/**
 * Réglages choisis dans l'outil, ou undefined tant que le joueur n'a rien choisi : l'outil
 * prend alors ceux par défaut, tirés des données (spawnChoice).
 */
export const spawnSettings = signal<SpawnSettings | undefined>(undefined);

/** Ce que l'outil d'apparition propose : chaque espèce et ses sous-espèces, nommées. */
export interface CreatorSetup {
  readonly species: readonly {
    readonly id: string;
    readonly name: MessageKey;
    readonly subspecies: readonly { readonly id: string; readonly name: MessageKey }[];
  }[];
  /** Taille d'un groupe : au moins, au plus, et au départ. */
  readonly count: { readonly min: number; readonly max: number; readonly initial: number };
}

/**
 * Ce que l'outil propose, tiré des données : chaque espèce de data/species.json et ses
 * sous-espèces, dans leur ordre. Une espèce ou une sous-espèce ajoutée aux données y paraît
 * d'elle-même.
 */
export function creatorSetup(
  species: readonly Species[],
  count: CreatorSetup['count'],
): CreatorSetup {
  return {
    species: species.map((entry) => ({
      id: entry.id,
      // Clés de traduction, vérifiées contre le catalogue par les tests des données.
      name: entry.name as MessageKey,
      subspecies: entry.subspecies.map((subspecies) => ({
        id: subspecies.id,
        name: subspecies.name as MessageKey,
      })),
    })),
    count,
  };
}

/**
 * Réglages que l'outil applique (U-11) : l'espèce et la sous-espèce choisies, tant que les
 * données les proposent, et sinon la première espèce des données et sa première
 * sous-espèce ; le nombre choisi, ou celui du départ, ramené dans ses bornes. Undefined si
 * les données n'ont aucune espèce.
 */
export function spawnChoice(
  setup: CreatorSetup,
  settings: SpawnSettings | undefined,
): SpawnSettings | undefined {
  const species =
    setup.species.find((entry) => entry.id === settings?.species) ?? setup.species.at(0);
  const subspecies =
    species?.subspecies.find((entry) => entry.id === settings?.subspecies) ??
    species?.subspecies.at(0);
  if (species === undefined || subspecies === undefined) return undefined;
  const { min, max, initial } = setup.count;
  const count = Math.min(max, Math.max(min, Math.round(settings?.count ?? initial)));
  return { species: species.id, subspecies: subspecies.id, count };
}

/** Fiche ouverte : un individu ou un groupe, tel que le worker l'a décrit. */
export type Sheet =
  | { readonly kind: 'person'; readonly view: PersonView }
  | { readonly kind: 'group'; readonly view: GroupView };
export const sheet = signal<Sheet | undefined>(undefined);

/**
 * Faits de la chronique reçus, du plus ancien au plus récent : les derniers, et les pages
 * plus anciennes demandées (app/chronicle.ts).
 */
export const chronicle = signal<readonly ChronicleView[]>([]);
export const chronicleOpen = signal(false);
/** Une page de faits plus anciens est demandée, et pas encore reçue. */
export const chronicleLoading = signal(false);

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
