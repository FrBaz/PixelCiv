/**
 * Outil d'apparition du Créateur (tâche 2.10 ; CRE-03) : choisir une espèce, une
 * sous-espèce et un nombre de personnes, puis toucher la carte, au doigt comme à la
 * souris, pour y faire apparaître un groupe nomade. Espèces et sous-espèces viennent des
 * données, comme les réglages de départ (spawnChoice, U-11). Le panneau prend le focus à
 * son ouverture ; Échap ou « Terminer » désarment l'outil (U-14).
 */
import { t } from '../i18n';
import { DialogFocus } from './dialog';
import {
  buried,
  raise,
  spawnChoice,
  spawnSettings,
  tool,
  type CreatorSetup,
  type SpawnSettings,
} from './store';

/** Focus du panneau : son titre à l'ouverture, son origine à la fermeture (dialog.ts). */
const focus = new DialogFocus();

const disarm = () => {
  tool.value = 'inspect';
};

/** Bouton de la barre du bas : il arme ou désarme l'outil. */
export function CreatorToggle() {
  const active = tool.value === 'spawn';
  return (
    <button
      type="button"
      class="creator-toggle"
      aria-pressed={active}
      onClick={() => {
        // Sur petit écran, un outil armé dont le panneau est caché sous un autre remonte.
        if (active && buried(document.querySelector('.creator-panel'))) raise('creator');
        else tool.value = active ? 'inspect' : 'spawn';
      }}
    >
      {t('creator.spawn')}
    </button>
  );
}

/** Réglages de l'outil, tant qu'il est armé. */
export function CreatorPanel({ setup }: { setup: CreatorSetup }) {
  if (tool.value !== 'spawn') return null;
  const settings = spawnChoice(setup, spawnSettings.value);
  const species = setup.species.find((entry) => entry.id === settings?.species);
  if (settings === undefined || species === undefined) return null;
  const choose = (changes: Partial<SpawnSettings>) => {
    spawnSettings.value = { ...settings, ...changes };
  };
  return (
    <div
      class="panel creator-panel"
      role="dialog"
      aria-label={t('creator.title')}
      onKeyDown={(event) => {
        focus.keyDown(event, disarm);
      }}
    >
      <div class="cell-info-head">
        <strong ref={focus.title} tabIndex={-1}>
          {t('creator.title')}
        </strong>
        <button
          type="button"
          onClick={() => {
            focus.close(disarm);
          }}
        >
          {t('creator.done')}
        </button>
      </div>
      {setup.species.length > 1 && (
        <div class="creator-choices" role="group" aria-label={t('creator.species')}>
          {setup.species.map((entry) => (
            <button
              type="button"
              key={entry.id}
              aria-pressed={entry.id === species.id}
              onClick={() => {
                // Une autre espèce : sa première sous-espèce.
                choose({ species: entry.id, subspecies: entry.subspecies.at(0)?.id ?? '' });
              }}
            >
              {t(entry.name)}
            </button>
          ))}
        </div>
      )}
      <div class="creator-choices" role="group" aria-label={t('creator.subspecies')}>
        {species.subspecies.map((entry) => (
          <button
            type="button"
            key={entry.id}
            aria-pressed={entry.id === settings.subspecies}
            onClick={() => {
              choose({ subspecies: entry.id });
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
            choose({ count: Number(event.currentTarget.value) });
          }}
        />
      </label>
      <p class="creator-hint">{t('creator.hint')}</p>
    </div>
  );
}
