/**
 * Chronique de base (tâche 2.10 ; CHR-01, CRE-05) : les faits notables des groupes,
 * datés et situés, du plus récent au plus ancien. Un fait s'ouvre d'un appui : la carte
 * se centre sur son lieu, et la fiche du groupe s'ouvre, s'il vit encore.
 */
import type { ChronicleView } from '../core/protocol';
import { ofName, t, type MessageKey } from '../i18n';
import { formatDate } from './calendar';
import { chronicle, chronicleOpen, type UiActions } from './store';

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
        chronicleOpen.value = !open;
      }}
    >
      {t('chronicle.toggle')}
    </button>
  );
}

export function ChroniclePanel({ actions }: { actions: UiActions }) {
  if (!chronicleOpen.value) return null;
  const entries = chronicle.value;
  return (
    <div class="panel chronicle" role="log" aria-label={t('chronicle.title')}>
      <strong>{t('chronicle.title')}</strong>
      {entries.length === 0 ? (
        <p>{t('chronicle.empty')}</p>
      ) : (
        <ol class="chronicle-entries">
          {[...entries].reverse().map((entry, index) => (
            <li key={`${String(entry.tick)}-${String(entries.length - index)}`}>
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
        </ol>
      )}
    </div>
  );
}
