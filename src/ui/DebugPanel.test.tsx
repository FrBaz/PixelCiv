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

describe('panneau de débogage (ADR 0013, ADR 0014, ADR 0015)', () => {
  it('montre la durée d’un jour et du pas mensuel, les jours par lot, les marcheurs et ce que coûtent les individus', () => {
    debugOpen.value = true;
    debugInfo.value = {
      fps: 59.6,
      drawnFps: 4.04,
      worstFrameMs: 18.24,
      dayMs: 0.0043,
      monthMs: 12.37,
      worstMonthMs: 20.5,
      batchDays: 2.6,
      walkers: 412,
      legsPerSecond: 1234.4,
      positionBytesPerSecond: 64 * 1024,
      main: { update: 6.004, render: 5.126 },
      timeline: { show: 0.31, receive: 0.058 },
      crowd: { positions: 1.234, sort: 0.5, sprites: 2.25 },
      drawn: 1987,
      textures: 140,
      cachedTextures: 412,
      pages: 1,
      drawCalls: 37,
      level: 1,
      k: 2,
      textureBytes: 2100 * 1024,
      objects: 5123,
      objectsMs: 0.4172,
      decorChunks: 12,
      decorBuildMs: 6.31,
      animals: 652,
      faunaDayMs: 0.3184,
      faunaDrawn: 37,
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
    // Ce que coûte une image au fil principal : la mise à jour de chaque tic, le rendu par
    // PixiJS de chaque image dessinée, puis, dans la mise à jour, l'instant affiché de la
    // chronologie, à côté des messages qu'elle reçoit.
    expect(shown.get('Mise à jour par tic, rendu par image dessinée')).toBe('6 + 5,13 ms');
    expect(shown.get('Chronologie : affichage, messages')).toBe('0,31 + 0,06 ms');
    // Les positions reçues, et ce que coûte au fil principal le dessin des individus.
    expect(shown.get('Positions reçues')).toBe('1\u202f234 étapes/s · 64 Kio/s');
    expect(shown.get('Positions, tri, sprites')).toBe('1,23 + 0,5 + 2,25 ms');
    expect(shown.get('Sprites dessinés')).toBe('1\u202f987');
    expect(shown.get('Apparences')).toBe("140 dans l'image, 412 gardées");
    expect(shown.get('Pages des bannières')).toBe('1');
    // Le niveau de motifs des humains et leur densité, et ce que pèsent leurs textures.
    expect(shown.get('Individus : niveau, densité')).toBe('niveau 1, k = 2');
    expect(shown.get('Textures des individus')).toBe('2\u202f100 Kio');
    expect(shown.get('Appels de dessin')).toBe('37');
    // Le décor (ADR 0017) : objets dessinés, leur mise à jour par image, blocs posés.
    expect(shown.get('Décor : objets, mise à jour, blocs posés')).toBe(
      '5\u202f123 objets · 0,42 ms · 12 blocs en 6,3 ms',
    );
    // Le gibier (ADR 0018) : ses animaux, ceux de la vue, et son jour, à trois décimales.
    expect(shown.get('Gibier : animaux, dessinés, jour')).toBe(
      '652 animaux · 37 dessinés · 0,318 ms par jour',
    );
    // Le rendu à la demande ne dessine que les images qui changent (ADR 0015) : les tics de
    // l'animation, et parmi eux les images dessinées.
    expect(shown.get('Tics par seconde')).toBe('60');
    expect(shown.get('Images dessinées par seconde')).toBe('4');
    expect(shown.get('Tic le plus long')).toBe('18,2 ms');
    // Sans mesure, chaque ligne le dit.
    debugInfo.value = {
      ...debugInfo.value,
      dayMs: undefined,
      monthMs: undefined,
      walkers: undefined,
      legsPerSecond: undefined,
      drawCalls: undefined,
      level: -1,
      objects: undefined,
      animals: undefined,
    };
    expect(rows().get('Individus : niveau, densité')).toBe('bannières');
    expect(rows().get('Marcheurs')).toBe('indisponible');
    expect(rows().get('Positions reçues')).toBe('indisponible');
    expect(rows().get('Appels de dessin')).toBe('indisponible');
    expect(rows().get('Décor : objets, mise à jour, blocs posés')).toBe('indisponible');
    expect(rows().get('Gibier : animaux, dessinés, jour')).toBe('indisponible');
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
