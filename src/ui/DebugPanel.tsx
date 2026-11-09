/**
 * Panneau de débogage (NF-01) : images par seconde, durée des pas, mémoire, monde,
 * contenu et auto-test du déterminisme. Il s'ouvre par son bouton, ou par F3 et la
 * touche ², au-dessus de Tab.
 */
import { useEffect } from 'preact/hooks';
import { t, type MessageKey } from '../i18n';
import { content, debugInfo, debugOpen, determinismOk, worldInfo } from './store';

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function milliseconds(value: number | undefined): string {
  return value === undefined ? t('debug.unavailable') : t('unit.ms', { value: round(value) });
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
  const size = worldInfo.value?.size;
  const biomes = content.value?.biomes;
  const determinism = determinismOk.value;
  const rows: [MessageKey, string][] = [
    [
      'debug.fps',
      info === undefined ? t('debug.unavailable') : t('unit.number', { value: round(info.fps, 0) }),
    ],
    ['debug.frame', milliseconds(info?.worstFrameMs)],
    ['debug.step', milliseconds(info?.stepMs)],
    ['debug.stepMax', milliseconds(info?.worstStepMs)],
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
    [
      'debug.world',
      size === undefined
        ? t('debug.unavailable')
        : t('debug.worldSize', { width: size.width, height: size.height }),
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
