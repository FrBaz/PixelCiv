/**
 * Fiches d'inspection (tâche 2.10 ; IHM-02, CRE-05) : un individu, vivant ou mort, ou un
 * groupe nomade. Les liens familiaux et les membres d'un groupe s'ouvrent d'un appui :
 * on suit les lignées de fiche en fiche. Chaque cible a sa fiche : une autre cible s'ouvre
 * en haut, son titre au focus (U-8, U-14) ; Échap la ferme.
 */
import type { Appearance, Genetics, Species } from '../core/data';
import { isMinor } from '../core/life';
import type { GroupSummary, GroupView, PersonSummary, PersonView } from '../core/protocol';
import { ofName, t, tKey, type MessageKey } from '../i18n';
import { formatDate } from './calendar';
import { DialogFocus } from './dialog';
import { Portrait } from './Portrait';
import { sheet, type Sheet, type UiActions } from './store';

/**
 * Ce que les fiches et les portraits lisent des données : espèces et sous-espèces, leurs
 * âges, la génétique et ses rôles, les couleurs des portraits.
 */
export interface SheetContent {
  readonly species: readonly Species[];
  readonly genetics: Genetics;
  readonly appearance: Appearance;
}

/**
 * « femme, 24 ans », « garçon, 6 ans », « nourrisson, 1 an » : selon la classe d'âge que
 * la simulation tire des âges de son espèce, celle de son mini-sprite (U-12).
 */
function identity(person: PersonSummary): string {
  const who: MessageKey =
    person.stage === 'baby'
      ? 'person.baby'
      : person.stage === 'child'
        ? person.sex === 0
          ? 'person.girl'
          : 'person.boy'
        : person.sex === 0
          ? 'person.woman'
          : 'person.man';
  return t('person.identity', { who: t(who), age: t('person.age', { count: person.age }) });
}

/**
 * Ce qu'un lien dit d'un parent : « fille, 11 ans » d'une vivante, « morte à 11 ans »
 * d'une morte. La mort s'écrit, pour se lire comme elle se voit (U-13 ; WCAG 1.4.1).
 */
function summary(person: PersonSummary): string {
  if (person.alive) return identity(person);
  const gender = person.sex === 0 ? 'feminine' : 'masculine';
  return person.age < 1
    ? t('person.diedYoung', { gender })
    : t('person.diedAt', { gender, age: t('person.age', { count: person.age }) });
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
      <small>{summary(person)}</small>
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

/** Focus de la fiche : son titre à l'ouverture, son origine à la fermeture (dialog.ts). */
const focus = new DialogFocus();

/** Ferme la fiche, et rend le focus à l'élément d'où elle s'était ouverte. */
function close(actions: UiActions): void {
  focus.close(() => {
    actions.closeSheet();
  });
}

/** Échap ferme la fiche, où que soit le focus en elle. */
function keyDown(actions: UiActions) {
  return (event: KeyboardEvent) => {
    focus.keyDown(event, () => {
      actions.closeSheet();
    });
  };
}

function Header({ title, actions }: { title: string; actions: UiActions }) {
  return (
    <div class="cell-info-head">
      <strong ref={focus.title} tabIndex={-1}>
        {title}
      </strong>
      <button
        type="button"
        aria-label={t('sheet.close')}
        title={t('sheet.close')}
        onClick={() => {
          close(actions);
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
    <div
      class="panel cell-info sheet"
      role="dialog"
      aria-label={t('person.title')}
      onKeyDown={keyDown(actions)}
    >
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
        {/* La taille d'un adulte ; celle qu'aura un enfant, puisqu'il grandit encore (U-12). */}
        <Row label={t(isMinor(person.stage) ? 'person.height.adult' : 'person.height')}>
          {t('unit.centimeters', { value: person.height })}
        </Row>
        {person.loci.map((entry) => {
          const locus = content.genetics.loci.find((item) => item.id === entry.locus);
          const allele = locus?.alleles.find((item) => item.id === entry.allele);
          if (locus === undefined || allele === undefined) return null;
          return (
            <Row key={entry.locus} label={tKey(locus.name)}>
              {tKey(allele.name)}
            </Row>
          );
        })}
        {person.traits.map((entry) => {
          const trait = content.genetics.traits.find((item) => item.id === entry.trait);
          // Un trait qui tient un rôle se montre autrement : le teint au portrait, la taille
          // en centimètres.
          if (trait === undefined || trait.role !== undefined) return null;
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
            t('person.mother.none')
          ) : (
            <PersonLink person={person.mother} actions={actions} />
          )}
        </Row>
        <Row label={t('person.father')}>
          {person.father === undefined ? (
            t('person.father.none')
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
      onKeyDown={keyDown(actions)}
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
            {/* Des coordonnées, et non des quantités : sans séparateur des milliers (U-15). */}
            {t('group.placeValue', { x: String(group.x), y: String(group.y) })}
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

/**
 * Clé de la fiche d'une cible : la même tant que la fiche se rafraîchit, une autre pour
 * une autre cible, qui recrée la fiche, en haut et son titre au focus (U-8, U-14).
 */
export function sheetKey(open: Sheet): string {
  return `${open.kind}:${String(open.view.id)}`;
}

/** La fiche ouverte, s'il y en a une. */
export function SheetPanel({ content, actions }: { content: SheetContent; actions: UiActions }) {
  const open = sheet.value;
  if (open === undefined) return null;
  return open.kind === 'person' ? (
    <PersonSheet key={sheetKey(open)} person={open.view} content={content} actions={actions} />
  ) : (
    <GroupSheet key={sheetKey(open)} group={open.view} actions={actions} />
  );
}
