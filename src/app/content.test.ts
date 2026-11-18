/**
 * Contenu en données (NF-07, ESP-03 ; D-6, A-10, U-12, W-12) : une sous-espèce et un allèle
 * de visage ajoutés à data/species.json et à data/genetics.json se valident, vivent, se
 * dessinent, se montrent dans les fiches et se choisissent dans l'outil d'apparition, sans
 * une ligne de code ; et les âges de la vie de l'espèce changent d'un même pas la carte et
 * les fiches.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkContent,
  loadGameData,
  type FaceShape,
  type Genetics,
  type Species,
} from '../core/data';
import { loadCatalog, loadSettings } from '../core/data/catalog';
import { GeneticsSchema, geneRoles, SpeciesListSchema } from '../core/data/people';
import { ageClass } from '../core/life';
import { AGE_CLASSES, decodeVisual } from '../core/visual';
import { portraitRoles } from '../gen/portrait';
import { SPAWN_COUNT } from '../sim/commands';
import { groupMembers } from '../sim/groups';
import { MONTHS_PER_YEAR } from '../sim/people';
import { step, type SimContent } from '../sim/step';
import { flatState, withHuman } from '../sim/testing';
import { groupsFrame, personView } from '../sim/views';
import { Portrait, portraitPixels } from '../ui/Portrait';
import { SheetPanel, type SheetContent } from '../ui/Sheet';
import { creatorSetup, sheet, spawnChoice, type UiActions } from '../ui/store';
import { expand, findAll, textOf } from '../ui/testing';

const data = loadGameData();

/** Un visage en cœur, inconnu du code : sa forme est sa seule description. */
const HEART: FaceShape = { width: 13, height: 16, power: 2, jaw: 0.45 };

/**
 * Les fichiers de data/, tels qu'un auteur de contenu les changerait : un allèle de visage
 * « en cœur », et une sous-espèce des hautes terres, en tête de liste, qui le porte toujours.
 * Ils passent par les mêmes schémas que les données livrées.
 */
function editedContent() {
  const faceLocus = data.genetics.loci.at(geneRoles(data.genetics).loci.face);
  if (faceLocus === undefined) throw new Error('pas de locus du visage');
  const genetics: Genetics = loadSettings('variante de data/genetics.json', GeneticsSchema, {
    ...data.genetics,
    loci: data.genetics.loci.map((locus) =>
      locus === faceLocus
        ? {
            ...locus,
            alleles: [
              ...locus.alleles,
              { id: 'heart', name: 'gene.face.oval', dominance: 3, face: HEART },
            ],
          }
        : locus,
    ),
  });
  const human = data.species.entries.at(0);
  const plains = human?.subspecies.at(1);
  if (human === undefined || plains === undefined) throw new Error('données incomplètes');
  const highland = {
    ...plains,
    id: 'highland',
    adaptation: { cold: 0.6, heat: 0.3, endurance: 0.9 },
    appearance: {
      ...plains.appearance,
      alleles: { ...plains.appearance.alleles, [faceLocus.id]: { heart: 1 } },
    },
  };
  const species = loadCatalog('variante de data/species.json', SpeciesListSchema, [
    { ...human, subspecies: [highland, ...human.subspecies.slice(0, 3)] } satisfies Species,
  ]);
  return { genetics, species };
}

describe('contenu en données : rien à coder pour une sous-espèce ou un allèle de visage', () => {
  it('se valide, vit, se dessine, se montre et se choisit', () => {
    const { genetics, species } = editedContent();
    expect(checkContent({ ...data, genetics, species })).toEqual([]);
    const content: SimContent = { ...data, genetics, species };

    // L'outil d'apparition la propose, et la prend d'abord : elle est la première des données.
    const setup = creatorSetup(species.entries, SPAWN_COUNT);
    expect(setup.species[0]?.subspecies.map((entry) => entry.id)).toContain('highland');
    expect(spawnChoice(setup, undefined)).toMatchObject({
      species: 'human',
      subspecies: 'highland',
    });

    // Un groupe des hautes terres apparaît et vit deux ans.
    const state = flatState();
    step(
      state,
      [{ type: 'spawnGroup', x: 40, y: 60, species: 'human', subspecies: 'highland', count: 20 }],
      content,
    );
    for (let month = 0; month < 2 * MONTHS_PER_YEAR; month++) step(state, [], content);
    const members = [...groupMembers(state.people).values()].flat();
    expect(members.length).toBeGreaterThan(10);
    const frame = groupsFrame(state, content);
    expect(frame.sprites).toHaveLength(members.length);

    // Chacun porte le visage en cœur ; sa fiche le nomme, et son portrait le dessine.
    const sheet: SheetContent = {
      species: species.entries,
      genetics,
      appearance: data.appearance,
    };
    const faceLocus = genetics.loci.at(geneRoles(genetics).loci.face);
    let hearts = 0;
    for (const slot of members) {
      const view = personView(state, content, state.people.get('id', slot));
      if (view === undefined) throw new Error('pas de fiche');
      expect(view.ancestry).toEqual([{ subspecies: 'highland', share: 1 }]);
      expect(portraitPixels(view, sheet)).toBeDefined();
      if (view.loci.find((entry) => entry.locus === faceLocus?.id)?.allele === 'heart') hearts++;
    }
    // Une mutation rare peut changer un allèle transmis ; tous les autres sont en cœur.
    expect(hearts).toBeGreaterThanOrEqual(members.length - 2);

    // Le cœur se dessine autrement que chacun des visages livrés.
    const human = species.entries.at(0);
    if (human === undefined) throw new Error('pas d’espèce');
    const portrait = (face: FaceShape | undefined) =>
      face === undefined
        ? []
        : Array.from(
            portraitRoles({
              sex: 0,
              age: 30,
              stage: ageClass(human, 30),
              species: human,
              face,
              nose: { length: 4, hump: false, wing: 2, base: false },
              variant: 1,
            }),
          );
    for (const allele of data.genetics.loci[geneRoles(data.genetics).loci.face]?.alleles ?? []) {
      expect(portrait(HEART)).not.toEqual(portrait(allele.face));
    }
  });
});

describe('âges de la vie en données : la carte et la fiche changent ensemble (U-12)', () => {
  afterEach(() => {
    sheet.value = undefined;
  });

  it('fait un homme d’un garçon de 13 ans quand les données fixent la maturité à 12 ans', () => {
    const early = withHuman((human) => ({ ...human, maturity: 12 }));
    const state = flatState();
    step(
      state,
      [{ type: 'spawnGroup', x: 40, y: 60, species: 'human', subspecies: 'plains', count: 12 }],
      early,
    );
    const members = [...groupMembers(state.people).values()].flat();
    // Quatre membres rajeunis : des garçons de 13, 11 et 2 ans, et une fille de 13 ans.
    const years = [13, 11, 2, 13];
    years.forEach((age, index) => {
      const slot = members[index] ?? -1;
      state.people.set('birth', slot, state.tick - age * MONTHS_PER_YEAR - 1);
      state.people.set('sex', slot, index === 3 ? 0 : 1);
    });
    const frame = groupsFrame(state, early);
    const content: SheetContent = {
      species: early.species.entries,
      genetics: early.genetics,
      appearance: data.appearance,
    };
    const actions = {} as UiActions;
    const seen = years.map((_, index) => {
      const view = personView(state, early, state.people.get('id', members[index] ?? -1));
      if (view === undefined) throw new Error('pas de fiche');
      sheet.value = { kind: 'person', view };
      const tree = expand(SheetPanel({ content, actions }), [Portrait]);
      // Le statut, en tête de la fiche, avant la date de naissance ; la ligne de la taille.
      const status = findAll(tree, (element) => element.type === 'p').at(0)?.props.children;
      const height = findAll(tree, (element) => element.type === 'dt')
        .map(textOf)
        .at(1);
      return {
        map: AGE_CLASSES[decodeVisual(frame.sprites[index] ?? 0).age],
        sheet: textOf(Array.isArray(status) ? status[0] : status),
        height,
      };
    });
    expect(seen).toEqual([
      { map: 'adult', sheet: 'homme, 13 ans', height: 'Taille' },
      { map: 'child', sheet: 'garçon, 11 ans', height: 'Taille adulte' },
      { map: 'baby', sheet: 'nourrisson, 2 ans', height: 'Taille adulte' },
      { map: 'adult', sheet: 'femme, 13 ans', height: 'Taille' },
    ]);
  });
});
