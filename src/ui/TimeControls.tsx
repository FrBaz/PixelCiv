/**
 * Contrôle du temps (MOD-06, ADR 0013) : date de la partie au jour près, à l'instant que
 * montre la carte, pause, pas unique d'un jour et vitesses. Les boutons portent des
 * symboles ; leurs noms passent par la traduction. La date garde une largeur fixe, en
 * chiffres tabulaires : les boutons ne bougent pas quand les jours défilent.
 */
import { SPEEDS, type SpeedId } from '../core/time';
import { t, type MessageKey } from '../i18n';
import { formatDay } from './calendar';
import { shownDay, time, type UiActions } from './store';

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
  const { paused, speed } = current;
  const toggle = paused ? t('time.resume') : t('time.pause');
  return (
    <div class="panel time-controls" role="group" aria-label={t('time.controls')}>
      <span class="time-date">{formatDay(shownDay.value ?? current)}</span>
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
