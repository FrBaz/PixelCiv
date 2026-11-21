/**
 * Réglage des effets (tâche 2b.7, ADR 0020) : trois boutons, pleins, atténués, coupés, dans la
 * barre du bas, après les modes de carte ; au téléphone, dans la ligne qui défile. Au doigt comme
 * à la souris, chaque bouton se montre pressé (aria-pressed) ; le cran choisi se garde dans les
 * préférences de l'appareil (UiActions.setEffects).
 */
import { t, type MessageKey } from '../i18n';
import { EFFECT_LEVELS, type EffectLevel } from './effects';
import { effectsLevel, worldInfo, type UiActions } from './store';

const LABELS: Readonly<Record<EffectLevel, MessageKey>> = {
  full: 'effects.full',
  reduced: 'effects.reduced',
  off: 'effects.off',
};

const HINTS: Readonly<Record<EffectLevel, MessageKey>> = {
  full: 'effects.full.hint',
  reduced: 'effects.reduced.hint',
  off: 'effects.off.hint',
};

export function EffectsMenu({ actions }: { actions: UiActions }) {
  if (worldInfo.value === undefined) return null;
  return (
    <div class="panel effects-menu" role="group" aria-label={t('effects.menu')}>
      <span class="effects-title" aria-hidden="true">
        {t('effects.menu')}
      </span>
      {EFFECT_LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          title={t(HINTS[level])}
          aria-pressed={effectsLevel.value === level}
          onClick={() => {
            actions.setEffects(level);
          }}
        >
          {t(LABELS[level])}
        </button>
      ))}
    </div>
  );
}
