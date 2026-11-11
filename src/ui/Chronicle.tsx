/**
 * Chronique de base (tâche 2.10 ; CHR-01, CRE-05) : les faits notables des groupes,
 * datés et situés, du plus récent au plus ancien, jusqu'au premier : les plus anciens se
 * demandent au worker, page après page. Un fait s'ouvre d'un appui : la carte se centre
 * sur son lieu, et la fiche du groupe s'ouvre, s'il vit encore. Chaque fait a pour clé son
 * rang dans la chronique, qui ne change pas : un fait nouveau n'en recrée aucun autre.
 */
import type { ChronicleView } from '../core/protocol';
import { ofName, t, type MessageKey } from '../i18n';
import { formatDate } from './calendar';
import { buried, chronicle, chronicleLoading, chronicleOpen, raise, type UiActions } from './store';

/** Message de chaque sorte de fait (sim/society.ts, CHRONICLE_KINDS). */
const KINDS: Readonly<Record<string, MessageKey>> = {
  groupAppeared: 'chronicle.groupAppeared',
  groupSplit: 'chronicle.groupSplit',
  groupExtinct: 'chronicle.groupExtinct',
  famine: 'chronicle.famine',
  groupMerged: 'chronicle.groupMerged',
};

/** Texte d'un fait. */
export function describe(entry: ChronicleView): string {
  const params = {
    count: entry.count,
    of: ofName(entry.group),
    other: entry.other,
    otherOf: ofName(entry.other),
  };
  return t(KINDS[entry.kind] ?? 'chronicle.groupAppeared', params);
}

export function ChronicleToggle() {
  const open = chronicleOpen.value;
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={() => {
        // Sur petit écran, une chronique ouverte sous un autre panneau remonte.
        if (open && buried(document.querySelector('.chronicle'))) raise('chronicle');
        else chronicleOpen.value = !open;
      }}
    >
      {t('chronicle.toggle')}
    </button>
  );
}

export function ChroniclePanel({ actions }: { actions: UiActions }) {
  if (!chronicleOpen.value) return null;
  const entries = chronicle.value;
  // Le premier fait gardé n'est pas le premier de la chronique : il y en a d'autres avant.
  const older = (entries.at(0)?.index ?? 0) > 0;
  return (
    <div class="panel chronicle" role="log" aria-label={t('chronicle.title')}>
      <div class="cell-info-head">
        <strong>{t('chronicle.title')}</strong>
        {/* Sur petit écran, la chronique peut couvrir son bouton de la barre du bas. */}
        <button
          type="button"
          aria-label={t('chronicle.close')}
          title={t('chronicle.close')}
          onClick={() => {
            chronicleOpen.value = false;
          }}
        >
          ×
        </button>
      </div>
      {entries.length === 0 ? (
        <p>{t('chronicle.empty')}</p>
      ) : (
        <ol class="chronicle-entries">
          {[...entries].reverse().map((entry) => (
            <li key={entry.index}>
              <button
                type="button"
                class="sheet-link"
                onClick={() => {
                  // Le lieu du fait, et la fiche du groupe s'il vit encore.
                  actions.focus(entry.x, entry.y);
                  actions.inspectGroup(entry.groupId);
                }}
              >
                <small>{formatDate(entry.tick)}</small>
                {describe(entry)}
              </button>
            </li>
          ))}
          {older && (
            // Au bout de la liste, après le plus ancien des faits gardés.
            <li key="older" class="chronicle-older">
              <button
                type="button"
                disabled={chronicleLoading.value}
                onClick={() => {
                  actions.olderChronicle();
                }}
              >
                {t(chronicleLoading.value ? 'chronicle.loading' : 'chronicle.older')}
              </button>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
