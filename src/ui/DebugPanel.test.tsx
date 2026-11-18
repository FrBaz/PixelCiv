import { afterEach, describe, expect, it } from 'vitest';
import { DebugPanel } from './DebugPanel';
import { TimeControls } from './TimeControls';
import { debugInfo, debugOpen, shownDay, time, type UiActions } from './store';
import { expand, findAll, textOf } from './testing';

afterEach(() => {
  debugOpen.value = false;
  debugInfo.value = undefined;
  time.value = undefined;
  shownDay.value = undefined;
});

/** Lignes du panneau de débogage : la valeur de chaque intitulé. */
function rows(): Map<string, string> {
  const tree = expand(<DebugPanel />);
  return new Map(
    findAll(tree, (node) => node.props.class === 'debug-row').map((row) => [
      textOf(findAll(row, (node) => node.type === 'dt')[0]),
      textOf(findAll(row, (node) => node.type === 'dd')[0]),
    ]),
  );
}

describe('panneau de débogage (ADR 0013, ADR 0014)', () => {
  it('montre la durée d’un jour et du pas mensuel, les jours par lot, les marcheurs et ce que coûtent les individus', () => {
    debugOpen.value = true;
    debugInfo.value = {
      fps: 59.6,
      worstFrameMs: 18.24,
      dayMs: 0.0043,
      monthMs: 12.37,
      worstMonthMs: 20.5,
      batchDays: 2.6,
      walkers: 412,
      legsPerSecond: 1234.4,
      positionBytesPerSecond: 64 * 1024,
      crowd: { positions: 1.234, sort: 0.5, sprites: 2.25 },
      drawn: 1987,
      textures: 140,
      cachedTextures: 412,
      drawCalls: 37,
      memoryMb: 140,
      renderer: { name: 'webgl', resolution: 1 },
      chunks: 0,
    };
    const shown = rows();
    // Quelques microsecondes, comme dans un petit monde, se lisent encore.
    expect(shown.get("Durée moyenne d'un jour")).toBe('0,004 ms');
    expect(shown.get('Durée moyenne du pas mensuel')).toBe('12,4 ms');
    expect(shown.get('Pas mensuel le plus long')).toBe('20,5 ms');
    expect(shown.get('Jours par lot')).toBe('2,6');
    expect(shown.get('Marcheurs')).toBe('412');
    // Les positions reçues, et ce que coûte au fil principal le dessin des individus.
    expect(shown.get('Positions reçues')).toBe('1\u202f234 étapes/s · 64 Kio/s');
    expect(shown.get('Positions, tri, sprites')).toBe('1,23 + 0,5 + 2,25 ms');
    expect(shown.get('Sprites dessinés')).toBe('1\u202f987');
    expect(shown.get('Textures')).toBe("140 dans l'image, 412 gardées");
    expect(shown.get('Appels de dessin')).toBe('37');
    // Sans mesure, chaque ligne le dit.
    debugInfo.value = {
      ...debugInfo.value,
      dayMs: undefined,
      monthMs: undefined,
      walkers: undefined,
      legsPerSecond: undefined,
      drawCalls: undefined,
    };
    expect(rows().get('Marcheurs')).toBe('indisponible');
    expect(rows().get('Positions reçues')).toBe('indisponible');
    expect(rows().get('Appels de dessin')).toBe('indisponible');
  });
});

describe('contrôle du temps (ADR 0013)', () => {
  const actions = { send: () => undefined } as unknown as UiActions;

  it('date le jour que montre la carte, et non le dernier état reçu', () => {
    time.value = { tick: 14, day: 20, paused: false, speed: 'faster' };
    shownDay.value = { tick: 14, day: 17 };
    const tree = expand(<TimeControls actions={actions} />);
    const [date] = findAll(tree, (node) => node.props.class === 'time-date');
    expect(textOf(date)).toBe("18 mars de l'an 2");
    // Avant la première image : le dernier état reçu.
    shownDay.value = undefined;
    const before = expand(<TimeControls actions={actions} />);
    expect(textOf(findAll(before, (node) => node.props.class === 'time-date')[0])).toBe(
      "21 mars de l'an 2",
    );
    // Le pas unique fait un jour.
    const step = findAll(before, (node) => node.props['aria-label'] === "Avancer d'un jour");
    expect(step).toHaveLength(1);
  });
});
