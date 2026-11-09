/**
 * Menu de la partie : un nouveau monde (écran de création, CRE-01), puis les
 * sauvegardes (NF-05) : sauvegarder et charger l'emplacement manuel, exporter la partie
 * dans un fichier et en importer un, pour passer d'un appareil à l'autre. Sauvegarder et
 * exporter attendent qu'une partie soit en cours.
 */
import { useRef } from 'preact/hooks';
import { t } from '../i18n';
import { worldInfo, type UiActions } from './store';

export function SaveMenu({ actions }: { actions: UiActions }) {
  const playing = worldInfo.value !== undefined;
  return (
    <div class="panel save-menu" role="group" aria-label={t('save.menu')}>
      <button
        type="button"
        onClick={() => {
          actions.openCreation();
        }}
      >
        {t('create.open')}
      </button>
      <button type="button" disabled={!playing} onClick={() => void actions.save()}>
        {t('save.save')}
      </button>
      <button type="button" onClick={() => void actions.load()}>
        {t('save.load')}
      </button>
      <button type="button" disabled={!playing} onClick={() => void actions.exportFile()}>
        {t('save.export')}
      </button>
      <ImportButton actions={actions} />
    </div>
  );
}

/** Importe une partie d'un fichier : un bouton, et le sélecteur de fichiers qu'il ouvre. */
export function ImportButton({ actions, disabled }: { actions: UiActions; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => input.current?.click()}>
        {t('save.import')}
      </button>
      <input
        ref={input}
        type="file"
        accept=".pxcv,application/octet-stream"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void actions.importFile(file);
        }}
      />
    </>
  );
}
