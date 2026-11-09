/**
 * Traduction : clés, paramètres, pluriels et genre (NF-06, POL-04).
 *
 * Un message est un texte, des formes plurielles (`one`, `other`… selon les règles
 * de la langue, `other` servant de repli) ou des formes selon le genre (`masculine`,
 * `feminine`), elles-mêmes textes ou formes plurielles. Les paramètres s'insèrent par
 * `{nom}` ; les nombres y sont mis en forme selon la langue.
 */

export type Gender = 'masculine' | 'feminine';

/** Paramètres d'un message : `count` choisit le pluriel, `gender` le genre. */
export interface MessageParams {
  readonly [name: string]: string | number | undefined;
  readonly count?: number;
  readonly gender?: Gender;
}

/** Catégories de pluriel d'Intl.PluralRules. */
const PLURAL_CATEGORIES: readonly string[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

type Catalog = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlural(value: unknown): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    typeof value.other === 'string' &&
    Object.entries(value).every(
      ([category, text]) => PLURAL_CATEGORIES.includes(category) && typeof text === 'string',
    )
  );
}

function isGendered(value: unknown): value is Readonly<Record<Gender, unknown>> {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    'masculine' in value &&
    'feminine' in value
  );
}

/** Problèmes de forme d'un catalogue : une entrée par message mal formé. */
export function checkCatalog(catalog: Catalog): string[] {
  const problems: string[] = [];
  const isText = (value: unknown): boolean => typeof value === 'string' || isPlural(value);
  for (const [key, message] of Object.entries(catalog)) {
    const valid =
      isText(message) ||
      (isGendered(message) && isText(message.masculine) && isText(message.feminine));
    if (!valid) problems.push(key);
  }
  return problems;
}

/** Crée une fonction de traduction pour une langue et son catalogue. */
export function createTranslator(locale: string, catalog: Catalog) {
  const plurals = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);

  function pick(message: unknown, params: MessageParams): string | undefined {
    if (typeof message === 'string') return message;
    if (isGendered(message)) return pick(message[params.gender ?? 'masculine'], params);
    if (isPlural(message)) return message[plurals.select(params.count ?? 0)] ?? message.other;
    return undefined;
  }

  return function translate(key: string, params: MessageParams = {}): string {
    const text = pick(catalog[key], params);
    // Une clé absente reste visible plutôt que de faire planter l'interface ; les tests
    // garantissent qu'aucune ne manque.
    if (text === undefined) return key;
    return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const value = params[name];
      if (value === undefined) return placeholder;
      return typeof value === 'number' ? numbers.format(value) : value;
    });
  };
}
