/**
 * Panneau de débogage (NF-01, ADR 0013, ADR 0014) : images par seconde, durée d'un jour et du
 * pas mensuel, jours par lot, marcheurs, positions reçues, ce que coûte le dessin des
 * individus au fil principal (positions, tri, sprites), sprites, textures et appels de dessin,
 * mémoire, monde (graine, taille, durée de la génération, blocs à cuire), contenu et
 * auto-test du déterminisme. Il s'ouvre par son bouton, ou par F3 et la touche ², au-dessus
 * de Tab.
 */
import { useEffect } from 'preact/hooks';
import { t, type MessageKey } from '../i18n';
import { content, debugInfo, debugOpen, determinismOk, generationMs, worldInfo } from './store';

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function milliseconds(value: number | undefined, digits = 1): string {
  return value === undefined
    ? t('debug.unavailable')
    : t('unit.ms', { value: round(value, digits) });
}

function number(value: number | undefined, digits: number): string {
  return value === undefined
    ? t('debug.unavailable')
    : t('unit.number', { value: round(value, digits) });
}

export function DebugToggle() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.code !== 'F3' && event.code !== 'Backquote') return;
      event.preventDefault();
      // Une touche maintenue ne fait pas clignoter le panneau.
      if (!event.repeat) debugOpen.value = !debugOpen.value;
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <button
      type="button"
      class="debug-toggle"
      aria-pressed={debugOpen.value}
      onClick={() => {
        debugOpen.value = !debugOpen.value;
      }}
    >
      {t('debug.toggle')}
    </button>
  );
}

export function DebugPanel() {
  if (!debugOpen.value) return null;
  const info = debugInfo.value;
  const world = worldInfo.value;
  const size = world?.size;
  const biomes = content.value?.biomes;
  const determinism = determinismOk.value;
  const rows: [MessageKey, string][] = [
    [
      'debug.fps',
      info === undefined ? t('debug.unavailable') : t('unit.number', { value: round(info.fps, 0) }),
    ],
    ['debug.frame', milliseconds(info?.worstFrameMs)],
    // Un jour ne coûte que quelques microsecondes dans un petit monde : trois décimales.
    ['debug.day', milliseconds(info?.dayMs, 3)],
    ['debug.month', milliseconds(info?.monthMs)],
    ['debug.monthMax', milliseconds(info?.worstMonthMs)],
    ['debug.batchDays', number(info?.batchDays, 1)],
    ['debug.walkers', number(info?.walkers, 0)],
    [
      'debug.positions',
      info?.legsPerSecond === undefined || info.positionBytesPerSecond === undefined
        ? t('debug.unavailable')
        : t('debug.positionsValue', {
            legs: Math.round(info.legsPerSecond),
            kib: round(info.positionBytesPerSecond / 1024),
          }),
    ],
    [
      'debug.crowdTime',
      info === undefined
        ? t('debug.unavailable')
        : t('debug.crowdTimeValue', {
            positions: round(info.crowd.positions, 2),
            sort: round(info.crowd.sort, 2),
            sprites: round(info.crowd.sprites, 2),
          }),
    ],
    ['debug.drawn', number(info?.drawn, 0)],
    [
      'debug.textures',
      info?.textures === undefined || info.cachedTextures === undefined
        ? t('debug.unavailable')
        : t('debug.texturesValue', { used: info.textures, cached: info.cachedTextures }),
    ],
    ['debug.pages', number(info?.pages, 0)],
    ['debug.drawCalls', number(info?.drawCalls, 0)],
    [
      'debug.memory',
      info?.memoryMb === undefined
        ? t('debug.unavailable')
        : t('unit.mb', { value: round(info.memoryMb) }),
    ],
    [
      'debug.renderer',
      info === undefined
        ? t('debug.unavailable')
        : t('debug.rendererValue', {
            name: info.renderer.name,
            resolution: round(info.renderer.resolution, 2),
          }),
    ],
    ['debug.seed', world === undefined ? t('debug.unavailable') : world.params.seed],
    [
      'debug.world',
      size === undefined
        ? t('debug.unavailable')
        : t('debug.worldSize', { width: size.width, height: size.height }),
    ],
    ['debug.generation', milliseconds(generationMs.value)],
    [
      'debug.chunks',
      info === undefined ? t('debug.unavailable') : t('debug.chunksValue', { count: info.chunks }),
    ],
    [
      'debug.content',
      biomes === undefined ? t('debug.unavailable') : t('debug.biomes', { count: biomes }),
    ],
    [
      'debug.determinism',
      determinism === undefined
        ? t('debug.unavailable')
        : determinism
          ? t('debug.determinism.ok')
          : t('debug.determinism.ko'),
    ],
  ];
  return (
    <section class="panel debug-panel" aria-label={t('debug.title')}>
      <dl>
        {rows.map(([key, value]) => (
          <div key={key} class="debug-row">
            <dt>{t(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
