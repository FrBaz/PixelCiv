import { afterEach, describe, expect, it } from 'vitest';
import { WORLD_SIZES } from '../core/world';
import { t } from '../i18n';
import { EFFECTS_HINT_ID, EffectsMenu } from './EffectsMenu';
import { type EffectLevel } from './effects';
import { effectsLevel, worldInfo, type UiActions } from './store';
import { buttons, expand, findAll, fire, textOf } from './testing';

afterEach(() => {
  effectsLevel.value = 'full';
  worldInfo.value = undefined;
});

/** Des actions qui ne retiennent que les crans demandés. */
function actions(chosen: EffectLevel[]): UiActions {
  return {
    setEffects: (level: EffectLevel) => {
      chosen.push(level);
      effectsLevel.value = level;
    },
  } as unknown as UiActions;
}

describe('réglage des effets dans la barre du bas (ADR 0020)', () => {
  it('ne se montre que pendant une partie', () => {
    expect(expand(<EffectsMenu actions={actions([])} />)).toBeNull();
  });

  it('montre trois boutons traduits, un seul pressé, et change de cran au clic ou au doigt', () => {
    worldInfo.value = {
      params: { seed: 'essai', size: 'small' } as never,
      size: WORLD_SIZES.small,
    };
    const chosen: EffectLevel[] = [];
    const menu = () => expand(<EffectsMenu actions={actions(chosen)} />);
    const tree = menu();
    expect(textOf(tree)).toContain(t('effects.menu'));
    const labels = buttons(tree).map(textOf);
    expect(labels).toEqual([t('effects.full'), t('effects.reduced'), t('effects.off')]);
    const pressed = () => buttons(menu()).map((button) => button.props['aria-pressed']);
    expect(pressed()).toEqual([true, false, false]);
    for (const [index, level] of (['reduced', 'off', 'full'] as const).entries()) {
      fire(buttons(menu()).at(index === 0 ? 1 : index === 1 ? 2 : 0), 'onClick');
      expect(chosen.at(-1)).toBe(level);
      expect(pressed().filter(Boolean)).toHaveLength(1);
    }
    effectsLevel.value = 'off';
    expect(pressed()).toEqual([false, false, true]);
    // Chaque bouton dit ce qu'il montre, et le groupe porte son nom.
    for (const button of buttons(menu())) expect(String(button.props.title)).not.toBe('');
  });

  it('écrit en clair, sous les boutons, ce que montre le cran choisi, qui les décrit', () => {
    // La relecture de 2b.7 (problème 4) : l'explication ne passait que par `title`, qu'un
    // appareil au doigt n'ouvre jamais.
    worldInfo.value = {
      params: { seed: 'essai', size: 'small' } as never,
      size: WORLD_SIZES.small,
    };
    const hint = () =>
      findAll(
        expand(<EffectsMenu actions={actions([])} />),
        (element) => element.props.id === EFFECTS_HINT_ID,
      );
    for (const [level, key] of [
      ['full', 'effects.full.hint'],
      ['reduced', 'effects.reduced.hint'],
      ['off', 'effects.off.hint'],
    ] as const) {
      effectsLevel.value = level;
      expect(hint().map(textOf)).toEqual([t(key)]);
    }
    const tree = expand(<EffectsMenu actions={actions([])} />);
    for (const button of buttons(tree)) {
      expect(button.props['aria-describedby']).toBe(EFFECTS_HINT_ID);
    }
    const group = findAll(tree, (element) => element.props.role === 'group');
    expect(group.map((element) => element.props['aria-describedby'])).toEqual([EFFECTS_HINT_ID]);
    // Au cran coupé, l'aide ne promet pas un décor sans saisons : il garde les siennes (ADR 0020).
    expect(t('effects.off.hint')).not.toMatch(/sans couleurs de saison/);
  });
});
