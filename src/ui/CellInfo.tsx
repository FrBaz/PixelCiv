/**
 * Inspection d'une case (IHM-02, première version) : un appui bref sur la carte montre
 * son biome, son altitude et son niveau, son climat, sa rivière, son gisement, les
 * ressources de son milieu et sa flore.
 */
import { LOCALE, t, type MessageKey } from '../i18n';
import { inspected } from './store';

const RIVERS: readonly MessageKey[] = [
  'inspect.river.stream',
  'inspect.river.river',
  'inspect.river.major',
];

const round = (value: number) => Math.round(value * 10) / 10;

/** Énumération dans la langue du jeu : « roseaux, poisson et gibier d'eau ». */
const list = new Intl.ListFormat(LOCALE, { style: 'long', type: 'conjunction' });

export function CellInfo() {
  const cell = inspected.value;
  if (cell === undefined) return null;
  const river = cell.river > 0 ? RIVERS.at(cell.river - 1) : undefined;
  const rows: [MessageKey, string][] = [
    ['inspect.biome', t(cell.biome)],
    [
      'inspect.altitude',
      t('inspect.altitudeValue', { level: t(cell.level), meters: Math.round(cell.elevation) }),
    ],
    ...(cell.depth > 0
      ? ([['inspect.depth', t('unit.meters', { value: Math.round(cell.depth) })]] as [
          MessageKey,
          string,
        ][])
      : []),
    [
      'inspect.temperature',
      t('inspect.temperatureValue', {
        annual: round(cell.temperature),
        monthly: round(cell.monthly),
      }),
    ],
    [
      'inspect.precipitation',
      t('inspect.precipitationValue', {
        annual: Math.round(cell.precipitation),
        monthly: Math.round(cell.monthlyPrecipitation),
      }),
    ],
    ...(river === undefined ? [] : ([['inspect.river', t(river)]] as [MessageKey, string][])),
    ...(cell.deposit === undefined
      ? []
      : ([['inspect.deposit', t(cell.deposit)]] as [MessageKey, string][])),
    ...(cell.resources.length === 0
      ? []
      : ([['inspect.resources', list.format(cell.resources.map((name) => t(name)))]] as [
          MessageKey,
          string,
        ][])),
    ['inspect.flora', t('inspect.floraValue', { trees: cell.trees, shrubs: cell.shrubs })],
  ];
  return (
    <div class="panel cell-info" role="dialog" aria-label={t('inspect.title')}>
      <div class="cell-info-head">
        <strong>{t('inspect.coordinates', { x: cell.x, y: cell.y })}</strong>
        <button
          type="button"
          aria-label={t('inspect.close')}
          title={t('inspect.close')}
          onClick={() => {
            inspected.value = undefined;
          }}
        >
          ×
        </button>
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div class="debug-row" key={label}>
            <dt>{t(label)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
