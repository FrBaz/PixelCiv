/**
 * Réglage des effets (tâche 2b.7, ADR 0020) : trois boutons, pleins, atténués, coupés, dans la
 * barre du bas, après les modes de carte ; au téléphone, dans la ligne qui défile. Au doigt comme
 * à la souris, chaque bouton se montre pressé (aria-pressed) ; le cran choisi se garde dans les
 * préférences de l'appareil (UiActions.setEffects). Ce que montre le cran choisi s'écrit sous les
 * boutons, en clair, et les décrit (aria-describedby) : au doigt, `title` ne s'ouvre jamais
 * (relecture de 2b.7, problème 4).
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

/** L'élément de l'explication du cran choisi, que décrivent le groupe et ses boutons. */
export const EFFECTS_HINT_ID = 'effects-hint';

export function EffectsMenu({ actions }: { actions: UiActions }) {
  if (worldInfo.value === undefined) return null;
  return (
    <div class="panel effects-menu">
      <div
        class="effects-row"
        role="group"
        aria-label={t('effects.menu')}
        aria-describedby={EFFECTS_HINT_ID}
      >
        <span class="effects-title" aria-hidden="true">
          {t('effects.menu')}
        </span>
        {EFFECT_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            title={t(HINTS[level])}
            aria-pressed={effectsLevel.value === level}
            aria-describedby={EFFECTS_HINT_ID}
            onClick={() => {
              actions.setEffects(level);
            }}
          >
            {t(LABELS[level])}
          </button>
        ))}
      </div>
      <p class="effects-hint" id={EFFECTS_HINT_ID} aria-live="polite">
        {t(HINTS[effectsLevel.value])}
      </p>
    </div>
  );
}
