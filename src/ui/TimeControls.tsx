/**
 * Contrôle du temps (MOD-06) : date de la partie, pause, pas unique et vitesses.
 * Les boutons portent des symboles ; leurs noms passent par la traduction.
 */
import { SPEEDS, type SpeedId } from '../core/time';
import { t, type MessageKey } from '../i18n';
import { formatDate } from './calendar';
import { time, type UiActions } from './store';

const SPEED_LABELS: Readonly<Record<SpeedId, { symbol: string; key: MessageKey }>> = {
  slow: { symbol: '×½', key: 'time.speed.slow' },
  normal: { symbol: '×1', key: 'time.speed.normal' },
  fast: { symbol: '×4', key: 'time.speed.fast' },
  faster: { symbol: '×16', key: 'time.speed.faster' },
};

/** Symboles en présentation texte (U+FE0E), pour éviter leur rendu en émoji. */
const PLAY = '▶︎';
const PAUSE = '❚❚';
const STEP = '▶︎❚';

export function TimeControls({ actions }: { actions: UiActions }) {
  const current = time.value;
  if (current === undefined) return null;
  const { paused, speed, tick } = current;
  const toggle = paused ? t('time.resume') : t('time.pause');
  return (
    <div class="panel time-controls" role="group" aria-label={t('time.controls')}>
      <span class="time-date">{formatDate(tick)}</span>
      <button
        type="button"
        aria-label={toggle}
        title={toggle}
        onClick={() => {
          actions.send({ type: 'setPaused', paused: !paused });
        }}
      >
        {paused ? PLAY : PAUSE}
      </button>
      <button
        type="button"
        aria-label={t('time.step')}
        title={t('time.step')}
        disabled={!paused}
        onClick={() => {
          actions.send({ type: 'stepOnce' });
        }}
      >
        {STEP}
      </button>
      {SPEEDS.map((id) => {
        const { symbol, key } = SPEED_LABELS[id];
        return (
          <button
            key={id}
            type="button"
            aria-label={t(key)}
            title={t(key)}
            aria-pressed={speed === id}
            onClick={() => {
              actions.send({ type: 'setSpeed', speed: id });
            }}
          >
            {symbol}
          </button>
        );
      })}
    </div>
  );
}
