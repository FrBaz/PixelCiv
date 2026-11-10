/**
 * Fiches d'inspection (tâche 2.10 ; IHM-02, CRE-05) : un individu, vivant ou mort, ou un
 * groupe nomade. Les liens familiaux et les membres d'un groupe s'ouvrent d'un appui :
 * on suit les lignées de fiche en fiche.
 */
import type { Appearance } from '../core/data';
import type { GroupSummary, GroupView, PersonSummary, PersonView } from '../core/protocol';
import { ofName, t, tKey, type MessageKey } from '../i18n';
import { formatDate } from './calendar';
import { Portrait } from './Portrait';
import { sheet, type UiActions } from './store';

/** Ce que les fiches nomment d'après les données : espèces, sous-espèces, gènes. */
export interface SheetContent {
  readonly species: readonly {
    readonly id: string;
    readonly name: string;
    readonly subspecies: readonly { readonly id: string; readonly name: string }[];
  }[];
  readonly loci: readonly {
    readonly id: string;
    readonly name: string;
    readonly alleles: readonly {
      readonly id: string;
      readonly name: string;
      readonly color?: string;
    }[];
  }[];
  readonly traits: readonly { readonly id: string; readonly name: string }[];
  readonly appearance: Appearance;
}

/** « femme, 24 ans », « garçon, 6 ans », « nourrisson, 1 an ». */
function identity(person: PersonSummary): string {
  const who: MessageKey =
    person.age < 3
      ? 'person.baby'
      : person.age < 15
        ? person.sex === 0
          ? 'person.girl'
          : 'person.boy'
        : person.sex === 0
          ? 'person.woman'
          : 'person.man';
  return t('person.identity', { who: t(who), age: t('person.age', { count: person.age }) });
}

function PersonLink({ person, actions }: { person: PersonSummary; actions: UiActions }) {
  return (
    <button
      type="button"
      class={person.alive ? 'sheet-link' : 'sheet-link sheet-dead'}
      onClick={() => {
        actions.inspectPerson(person.id);
      }}
    >
      {person.name}
      <small>{identity(person)}</small>
    </button>
  );
}

function GroupLink({ group, actions }: { group: GroupSummary; actions: UiActions }) {
  return (
    <button
      type="button"
      class="sheet-link"
      onClick={() => {
        actions.inspectGroup(group.id);
      }}
    >
      {t('group.name', { of: ofName(group.name) })}
      <small>{t('group.members', { count: group.size })}</small>
    </button>
  );
}

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class="debug-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Header({ title, actions }: { title: string; actions: UiActions }) {
  return (
    <div class="cell-info-head">
      <strong>{title}</strong>
      <button
        type="button"
        aria-label={t('sheet.close')}
        title={t('sheet.close')}
        onClick={() => {
          actions.closeSheet();
        }}
      >
        ×
      </button>
    </div>
  );
}

/** Causes de mort (IND-04) et règles de nommage (IND-08), nommées. */
const CAUSES: Readonly<Record<string, MessageKey>> = {
  natural: 'person.cause.natural',
  disease: 'person.cause.disease',
  famine: 'person.cause.famine',
  accident: 'person.cause.accident',
  cold: 'person.cause.cold',
  childbirth: 'person.cause.childbirth',
  heat: 'person.cause.heat',
};

const NAMING: Readonly<Record<string, MessageKey>> = {
  father: 'group.naming.father',
  mother: 'group.naming.mother',
  both: 'group.naming.both',
  none: 'group.naming.none',
  earned: 'group.naming.earned',
};

const level = (value: number): MessageKey =>
  value < 0.4 ? 'trait.level.low' : value < 0.6 ? 'trait.level.medium' : 'trait.level.high';

function PersonSheet({
  person,
  content,
  actions,
}: {
  person: PersonView;
  content: SheetContent;
  actions: UiActions;
}) {
  const species = content.species.find((entry) => entry.id === person.species);
  const gender = person.sex === 0 ? 'feminine' : 'masculine';
  const date = (tick: number) => t('person.dateIn', { date: formatDate(tick) });
  const food: MessageKey =
    person.nutrition > 0.8
      ? 'person.food.good'
      : person.nutrition > 0.5
        ? 'person.food.low'
        : 'person.food.hunger';
  const status =
    person.death === undefined
      ? identity(person)
      : t('person.dead', {
          gender,
          date: date(person.death),
          cause: t(CAUSES[person.cause ?? 'natural'] ?? 'person.cause.natural'),
        });
  const ancestry = person.ancestry
    .map((entry) => {
      const name = species?.subspecies.find((sub) => sub.id === entry.subspecies)?.name;
      return t('person.share', {
        name: name === undefined ? entry.subspecies : tKey(name),
        percent: Math.round(entry.share * 100),
      });
    })
    .join(', ');
  const list = (people: readonly PersonSummary[]) =>
    people.length === 0 ? (
      t('person.none')
    ) : (
      <span class="sheet-links">
        {people.map((relative) => (
          <PersonLink key={relative.id} person={relative} actions={actions} />
        ))}
      </span>
    );
  return (
    <div class="panel cell-info sheet" role="dialog" aria-label={t('person.title')}>
      <Header title={person.name} actions={actions} />
      <div class="sheet-top">
        <Portrait person={person} content={content} />
        <p>
          {status}
          <br />
          <small>{t('person.born', { gender, date: formatDate(person.birth) })}</small>
        </p>
      </div>
      <dl>
        <Row label={t('person.ancestry')}>{ancestry}</Row>
        <Row label={t('person.height')}>{t('unit.centimeters', { value: person.height })}</Row>
        {person.loci.map((entry) => {
          const locus = content.loci.find((item) => item.id === entry.locus);
          const allele = locus?.alleles.find((item) => item.id === entry.allele);
          if (locus === undefined || allele === undefined) return null;
          return (
            <Row key={entry.locus} label={tKey(locus.name)}>
              {tKey(allele.name)}
            </Row>
          );
        })}
        {person.traits
          .filter((entry) => entry.trait !== 'skin' && entry.trait !== 'height')
          .map((entry) => {
            const trait = content.traits.find((item) => item.id === entry.trait);
            if (trait === undefined) return null;
            return (
              <Row key={entry.trait} label={tKey(trait.name)}>
                {t(level(entry.value))}
              </Row>
            );
          })}
        {person.alive && <Row label={t('person.food')}>{t(food)}</Row>}
        {person.pregnant && <Row label={t('person.pregnant')}>✓</Row>}
        <Row label={t('person.mother')}>
          {person.mother === undefined ? (
            t('person.none')
          ) : (
            <PersonLink person={person.mother} actions={actions} />
          )}
        </Row>
        <Row label={t('person.father')}>
          {person.father === undefined ? (
            t('person.none')
          ) : (
            <PersonLink person={person.father} actions={actions} />
          )}
        </Row>
        {person.partner !== undefined && (
          <Row
            label={t('person.partner', {
              gender: person.partner.sex === 0 ? 'feminine' : 'masculine',
            })}
          >
            <PersonLink person={person.partner} actions={actions} />
          </Row>
        )}
        <Row label={t('person.children')}>{list(person.children)}</Row>
        <Row label={t('person.siblings')}>{list(person.siblings)}</Row>
        {person.group !== undefined && (
          <Row label={t('person.group')}>
            <GroupLink group={person.group} actions={actions} />
          </Row>
        )}
      </dl>
    </div>
  );
}

function GroupSheet({ group, actions }: { group: GroupView; actions: UiActions }) {
  return (
    <div
      class="panel cell-info sheet"
      role="dialog"
      aria-label={t('group.title', { of: ofName(group.name) })}
    >
      <Header title={t('group.title', { of: ofName(group.name) })} actions={actions} />
      <dl>
        <Row label={t('group.place')}>
          <button
            type="button"
            class="sheet-link"
            onClick={() => {
              actions.focus(group.x, group.y);
            }}
          >
            {t('group.placeValue', { x: group.x, y: group.y })}
          </button>
        </Row>
        <Row label={t('group.founded')}>{formatDate(group.founded)}</Row>
        {group.parent !== undefined && (
          <Row label={t('group.parent')}>
            <GroupLink group={group.parent} actions={actions} />
          </Row>
        )}
        <Row label={t('group.reserve')}>
          {t('group.reserveValue', { count: Math.round(group.reserve) })}
        </Row>
        <Row label={t('group.naming')}>{t(NAMING[group.naming] ?? 'group.naming.father')}</Row>
        <Row label={t('group.members', { count: group.members.length })}>
          <span class="sheet-links">
            {group.members.map((member) => (
              <PersonLink key={member.id} person={member} actions={actions} />
            ))}
          </span>
        </Row>
      </dl>
    </div>
  );
}

/** La fiche ouverte, s'il y en a une. */
export function SheetPanel({ content, actions }: { content: SheetContent; actions: UiActions }) {
  const open = sheet.value;
  if (open === undefined) return null;
  return open.kind === 'person' ? (
    <PersonSheet person={open.view} content={content} actions={actions} />
  ) : (
    <GroupSheet group={open.view} actions={actions} />
  );
}
