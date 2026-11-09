/** Avis passager, qui s'efface de lui-même après quelques secondes. */
import { useEffect } from 'preact/hooks';
import { t } from '../i18n';
import { notice } from './store';

const NOTICE_MS = 4000;

export function Notice() {
  const key = notice.value;
  useEffect(() => {
    if (key === undefined) return;
    const timer = setTimeout(() => {
      notice.value = undefined;
    }, NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [key]);
  if (key === undefined) return null;
  return (
    <div class="panel notice" role="status">
      <span>{t(key)}</span>
      <button
        type="button"
        aria-label={t('notice.close')}
        title={t('notice.close')}
        onClick={() => {
          notice.value = undefined;
        }}
      >
        ×
      </button>
    </div>
  );
}
