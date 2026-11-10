/**
 * Écran de création (tâche 1.9 ; CRE-01, MON-02, MON-03, MON-14) : graine, taille,
 * paramètres de la génération et aperçu du monde, que chaque réglage recalcule.
 * « Régénérer » tire une autre graine ; « Créer le monde » lance la génération, dont
 * l'écran suit les étapes. Il se manie au doigt : cibles de 44 px, curseurs pleine
 * largeur, défilement vertical sur les petits écrans.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { PARAMETER_NAMES, type ParameterName } from '../core/data/worldgen';
import { WORLD_SIZES, type GenerationStage, type WorldSizeId } from '../core/world';
import { defaultWorldParams, MAX_SEED_LENGTH, type WorldParams } from '../core/worldParams';
import { LOCALE, t, type MessageKey } from '../i18n';
import { ImportButton } from './SaveMenu';
import { randomSeed } from './seed';
import {
  creationBusy,
  creationPending,
  generation,
  PREVIEW_COLUMNS,
  previewImage,
  previewKey,
  worldInfo,
  type CreationSetup,
  type UiActions,
} from './store';

const SIZE_LABELS: Readonly<Record<WorldSizeId, MessageKey>> = {
  small: 'create.size.small',
  medium: 'create.size.medium',
  large: 'create.size.large',
  huge: 'create.size.huge',
};

const PARAMETER_LABELS: Readonly<Record<ParameterName, MessageKey>> = {
  landShare: 'create.param.landShare',
  seaLevel: 'create.param.seaLevel',
  relief: 'create.param.relief',
  temperature: 'create.param.temperature',
  humidity: 'create.param.humidity',
  rivers: 'create.param.rivers',
};

const STAGE_LABELS: Readonly<Record<GenerationStage, MessageKey>> = {
  relief: 'create.stage.relief',
  climate: 'create.stage.climate',
  hydrology: 'create.stage.hydrology',
  biomes: 'create.stage.biomes',
  resources: 'create.stage.resources',
};

/** Part de la hauteur de l'écran que l'aperçu peut occuper. */
const PREVIEW_HEIGHT = 0.38;

const signed = new Intl.NumberFormat(LOCALE, {
  signDisplay: 'exceptZero',
  maximumFractionDigits: 1,
});

const percent = (value: number) => t('create.value.percent', { value: Math.round(value * 100) });

/** Valeur affichée de chaque paramètre. */
const FORMATS: Readonly<Record<ParameterName, (value: number) => string>> = {
  landShare: percent,
  seaLevel: (value) => signed.format(value),
  relief: percent,
  temperature: (value) => t('create.value.celsius', { value: signed.format(value) }),
  humidity: percent,
  rivers: percent,
};

export function CreateWorld({ actions, setup }: { actions: UiActions; setup: CreationSetup }) {
  // Un monde neuf : une autre graine, mais les réglages du monde en cours, s'il y en a un.
  const [params, setParams] = useState<WorldParams>(() => {
    const current = worldInfo.value?.params;
    const seed = randomSeed();
    if (current === undefined) return defaultWorldParams(setup.parameters, seed, setup.defaultSize);
    // Une taille que l'appareil ne propose pas (un Immense importé sur un téléphone) revient
    // à la taille par défaut.
    const size = setup.sizes.includes(current.size) ? current.size : setup.defaultSize;
    return { ...current, seed, size };
  });
  const dialog = useRef<HTMLElement>(null);
  // Génération ou chargement en cours : l'écran attend.
  const pending = creationPending.value || creationBusy.value;
  const playing = worldInfo.value !== undefined;
  const valid = params.seed.length > 0;
  const key = previewKey(params);

  // Chaque réglage redemande l'aperçu ; la taille, qui ne change pas les continents, non.
  useEffect(() => {
    if (valid) actions.preview(params);
  }, [key]);

  // Le focus va à l'écran, pas au champ de la graine : sur un téléphone, le clavier
  // couvrirait l'aperçu.
  useEffect(() => {
    dialog.current?.focus();
  }, []);

  const update = (changes: Partial<WorldParams>) => {
    setParams((current) => ({ ...current, ...changes }));
  };
  const cancel = () => {
    if (playing && !pending) actions.closeCreation();
  };

  return (
    <section
      ref={dialog}
      class="create-screen"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-title"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') cancel();
      }}
    >
      <form
        class="panel create-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !pending) actions.create(params);
        }}
      >
        <h1 id="create-title">{t('create.title')}</h1>
        <div class="create-body">
          <div class="create-world">
            <Preview stale={valid && previewImage.value?.key !== key} />
            <div class="create-seed">
              <label for="create-seed">{t('create.seed')}</label>
              <div class="create-seed-row">
                <input
                  id="create-seed"
                  type="text"
                  value={params.seed}
                  maxLength={MAX_SEED_LENGTH}
                  autocomplete="off"
                  spellcheck={false}
                  enterKeyHint="go"
                  disabled={pending}
                  onInput={(event) => {
                    update({ seed: event.currentTarget.value });
                  }}
                />
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    update({ seed: randomSeed() });
                  }}
                >
                  {t('create.regenerate')}
                </button>
              </div>
            </div>
            <fieldset class="create-sizes" disabled={pending}>
              <legend>{t('create.size')}</legend>
              {setup.sizes.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={params.size === id}
                  onClick={() => {
                    update({ size: id });
                  }}
                >
                  <span>{t(SIZE_LABELS[id])}</span>
                  <small>
                    {t('create.sizeValue', WORLD_SIZES[id])}
                    {id === 'huge' && ` · ${t('create.experimental')}`}
                  </small>
                </button>
              ))}
            </fieldset>
          </div>
          <fieldset class="create-params" disabled={pending}>
            <legend>{t('create.params')}</legend>
            {PARAMETER_NAMES.map((name) => {
              const range = setup.parameters[name];
              const id = `create-${name}`;
              return (
                <div key={name} class="create-param">
                  <label for={id}>{t(PARAMETER_LABELS[name])}</label>
                  <output for={id}>{FORMATS[name](params[name])}</output>
                  <input
                    id={id}
                    type="range"
                    min={range.min}
                    max={range.max}
                    step={range.step}
                    value={params[name]}
                    onInput={(event) => {
                      update({ [name]: Number(event.currentTarget.value) });
                    }}
                  />
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setParams((current) =>
                  defaultWorldParams(setup.parameters, current.seed, current.size),
                );
              }}
            >
              {t('create.defaults')}
            </button>
          </fieldset>
        </div>
        {/* Pied collé au bas de l'écran : l'action principale et la progression restent
            visibles quand les réglages défilent, sur un téléphone. */}
        <div class="create-footer">
          {pending ? <Progress /> : playing && <p class="create-warning">{t('create.replace')}</p>}
          <div class="create-actions">
            {/* Sans partie en cours, une sauvegarde ou une partie venue d'un autre appareil
                se reprend d'ici ; sinon, le menu de la partie y pourvoit. */}
            {!playing && (
              <div class="create-saves">
                <button type="button" disabled={pending} onClick={() => void actions.load()}>
                  {t('save.load')}
                </button>
                <ImportButton actions={actions} disabled={pending} />
              </div>
            )}
            {playing && (
              <button type="button" disabled={pending} onClick={cancel}>
                {t('create.cancel')}
              </button>
            )}
            <button type="submit" class="create-start" disabled={!valid || pending}>
              {t('create.start')}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

/**
 * Aperçu du monde, à une échelle entière de pixels physiques : chaque case y couvre le
 * même nombre de pixels de l'écran, comme sur la carte.
 */
function Preview({ stale }: { stale: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(0);
  const image = previewImage.value;
  const columns = image?.width ?? PREVIEW_COLUMNS;
  const rows = image?.height ?? PREVIEW_COLUMNS / 2;

  // L'échelle tient dans la largeur du cadre et dans 38 % de la hauteur de l'écran : en
  // paysage, sur un téléphone, l'aperçu reste visible à côté des réglages.
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const measure = () => {
      const byWidth = Math.floor((element.clientWidth * devicePixelRatio) / columns);
      const byHeight = Math.floor((window.innerHeight * PREVIEW_HEIGHT * devicePixelRatio) / rows);
      setScale(Math.max(1, Math.min(byWidth, byHeight)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [columns, rows]);

  useEffect(() => {
    const element = canvas.current;
    if (element === null || image === undefined) return;
    element.width = image.width;
    element.height = image.height;
    element
      .getContext('2d')
      ?.putImageData(new ImageData(image.pixels, image.width, image.height), 0, 0);
  }, [image]);

  const ratio = scale / devicePixelRatio;
  return (
    <div ref={frame} class="create-frame">
      <canvas
        ref={canvas}
        role="img"
        aria-label={t('create.preview')}
        style={scale > 0 ? { width: `${columns * ratio}px`, height: `${rows * ratio}px` } : {}}
      />
      {(stale || image === undefined) && (
        <span class="create-busy" role="status">
          {t('create.previewPending')}
        </span>
      )}
    </div>
  );
}

/** Étapes de la génération : celle en cours, et la barre de progression. */
function Progress() {
  const current = generation.value;
  return (
    <div class="create-progress" role="status">
      <span>
        {current === undefined
          ? t('create.generating')
          : t('create.stage', {
              stage: t(STAGE_LABELS[current.stage]),
              step: current.step + 1,
              steps: current.steps,
            })}
      </span>
      <progress max={current?.steps ?? 1} value={current?.step ?? 0} />
    </div>
  );
}
