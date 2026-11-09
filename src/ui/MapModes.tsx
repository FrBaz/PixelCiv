/**
 * Modes de carte (IHM-01) et leur légende : naturel, relief, biomes, ressources. La
 * légende, repliable, liste les couleurs du mode affiché.
 */
import { useState } from 'preact/hooks';
import { t, type MessageKey } from '../i18n';
import { legendEntries, mapMode, worldInfo, type MapModeId, type UiActions } from './store';

const MODES: readonly { readonly id: MapModeId; readonly label: MessageKey }[] = [
  { id: 'natural', label: 'map.mode.natural' },
  { id: 'relief', label: 'map.mode.relief' },
  { id: 'biomes', label: 'map.mode.biomes' },
  { id: 'resources', label: 'map.mode.resources' },
];

export function MapModes({ actions }: { actions: UiActions }) {
  if (worldInfo.value === undefined) return null;
  return (
    <div class="panel map-modes" role="group" aria-label={t('map.modes')}>
      {MODES.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={mapMode.value === id}
          onClick={() => {
            actions.setMapMode(id);
          }}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}

export function Legend() {
  const [open, setOpen] = useState(true);
  const entries = legendEntries.value;
  if (mapMode.value === 'natural' || entries.length === 0) return null;
  return (
    <div class="panel legend">
      <button
        type="button"
        class="legend-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {t('map.legend')}
      </button>
      {open && (
        <ul class="legend-entries">
          {entries.map((entry) => (
            <li key={entry.label}>
              <span class="legend-swatch" style={{ background: entry.color }} />
              {t(entry.label)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
