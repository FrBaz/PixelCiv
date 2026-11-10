/**
 * Outil d'apparition du Créateur (tâche 2.10 ; CRE-03) : choisir une sous-espèce et un
 * nombre de personnes, puis toucher la carte, au doigt comme à la souris, pour y faire
 * apparaître un groupe nomade.
 */
import { t } from '../i18n';
import { spawnSettings, tool, type CreatorSetup } from './store';

/** Bouton de la barre du bas : il arme ou désarme l'outil. */
export function CreatorToggle() {
  const active = tool.value === 'spawn';
  return (
    <button
      type="button"
      class="creator-toggle"
      aria-pressed={active}
      onClick={() => {
        tool.value = active ? 'inspect' : 'spawn';
      }}
    >
      {t('creator.spawn')}
    </button>
  );
}

/** Réglages de l'outil, tant qu'il est armé. */
export function CreatorPanel({ setup }: { setup: CreatorSetup }) {
  if (tool.value !== 'spawn') return null;
  const settings = spawnSettings.value;
  const species =
    setup.species.find((entry) => entry.id === settings.species) ?? setup.species.at(0);
  if (species === undefined) return null;
  return (
    <div class="panel creator-panel" role="dialog" aria-label={t('creator.title')}>
      <strong>{t('creator.title')}</strong>
      <div class="creator-choices" role="group" aria-label={t('creator.subspecies')}>
        {species.subspecies.map((entry) => (
          <button
            type="button"
            key={entry.id}
            aria-pressed={settings.subspecies === entry.id}
            onClick={() => {
              spawnSettings.value = { ...settings, species: species.id, subspecies: entry.id };
            }}
          >
            {t(entry.name)}
          </button>
        ))}
      </div>
      <label class="creator-count">
        <span>{t('creator.count', { count: settings.count })}</span>
        <input
          type="range"
          min={setup.count.min}
          max={setup.count.max}
          step={1}
          value={settings.count}
          onInput={(event) => {
            spawnSettings.value = { ...settings, count: Number(event.currentTarget.value) };
          }}
        />
      </label>
      <p class="creator-hint">{t('creator.hint')}</p>
      <button
        type="button"
        onClick={() => {
          tool.value = 'inspect';
        }}
      >
        {t('creator.done')}
      </button>
    </div>
  );
}
