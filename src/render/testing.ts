/**
 * Aides des essais du rendu : une évaluation hors du GPU des expressions GLSL que les shaders
 * assemblent (src/render/humanShader.ts, PALETTE_ADDRESS ; src/render/mapShader.ts, COVER_GLSL),
 * pour vérifier qu'elles calculent ce que calcule le code du fil principal.
 */

/**
 * Évalue une expression GLSL : nombres, variables (pointées comme `data.r`), + − * /, moins
 * unaire, parenthèses, comparaisons (< > <= >= == !=), conditionnelle `? :`, et les fonctions
 * floor, mod, clamp, min et max. Chaque résultat s'arrondit en flottant de 32 bits, comme le
 * calcule un GPU en précision haute ; une comparaison vaut 1 ou 0.
 */
export function evaluateGlsl(
  expression: string,
  variables: Readonly<Record<string, number>>,
): number {
  const tokens = expression.match(/\d+\.\d+|\d+|[A-Za-z_][\w.]*|<=|>=|==|!=|[-+*/(),<>?:]/g) ?? [];
  let at = 0;
  const next = () => tokens[at++] ?? '';
  const peek = () => tokens[at] ?? '';
  const f = Math.fround;
  const call = (name: string, args: number[]): number => {
    const [x = Number.NaN, y = Number.NaN, z = Number.NaN] = args;
    switch (name) {
      case 'floor':
        return Math.floor(x);
      case 'mod':
        return f(x - f(y * Math.floor(f(x / y))));
      case 'clamp':
        return Math.min(z, Math.max(y, x));
      case 'min':
        return Math.min(x, y);
      case 'max':
        return Math.max(x, y);
      default:
        throw new Error(`fonction inconnue : ${name}`);
    }
  };
  const primary = (): number => {
    const token = next();
    if (token === '(') {
      const value = conditional();
      next();
      return value;
    }
    if (token === '-') return f(-primary());
    if (/^\d/.test(token)) return f(Number(token));
    if (peek() === '(') {
      next();
      const args = [conditional()];
      while (peek() === ',') {
        next();
        args.push(conditional());
      }
      next();
      return call(token, args);
    }
    if (!Object.hasOwn(variables, token)) throw new Error(`variable inconnue : ${token}`);
    return f(variables[token] ?? Number.NaN);
  };
  const product = (): number => {
    let value = primary();
    while (peek() === '*' || peek() === '/') {
      const operator = next();
      const right = primary();
      value = f(operator === '*' ? value * right : value / right);
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const operator = next();
      const right = product();
      value = f(operator === '+' ? value + right : value - right);
    }
    return value;
  };
  const comparison = (): number => {
    const left = sum();
    const operator = peek();
    if (!['<', '>', '<=', '>=', '==', '!='].includes(operator)) return left;
    next();
    const right = sum();
    const results: Partial<Record<string, boolean>> = {
      '<': left < right,
      '>': left > right,
      '<=': left <= right,
      '>=': left >= right,
      '==': left === right,
      '!=': left !== right,
    };
    return results[operator] === true ? 1 : 0;
  };
  const conditional = (): number => {
    const test = comparison();
    if (peek() !== '?') return test;
    next();
    const yes = conditional();
    next();
    const no = conditional();
    return test !== 0 ? yes : no;
  };
  const value = conditional();
  if (at !== tokens.length) throw new Error(`expression mal lue : ${expression}`);
  return value;
}

/** Les entrées d'une évaluation de la couverture d'un pixel, telles que le shader les lit. */
export interface CoverInputs {
  /** Rouge, vert et bleu du texel de la case dans la texture des saisons (octets). */
  readonly texel: readonly [number, number, number];
  /** Les quatre octets du calendrier de la couverture du pixel. */
  readonly calendar: ArrayLike<number>;
  /** La rampe de la couverture du pixel : début, étendue, part pleine. */
  readonly ramp: readonly [number, number, number];
  /** Les uniformes uSeason et uDay. */
  readonly season: number;
  readonly day: number;
}

/**
 * La couverture d'un pixel hors du GPU : les expressions de COVER_GLSL évaluées dans l'ordre où
 * le shader de la carte les assemble (mapShader.ts, MAP_FRAGMENT), most d'abord, puis, s'il est
 * positif, le calendrier, summer, now, level et share ; la part couverte avant celle des forêts.
 */
export function evaluateCover(
  glsl: Readonly<Record<string, string>>,
  inputs: CoverInputs,
): { readonly share: number; readonly variables: Readonly<Record<string, number>> } {
  const variables: Record<string, number> = {
    'data.r': inputs.texel[0] / 255,
    'data.g': inputs.texel[1] / 255,
    'data.b': inputs.texel[2] / 255,
    uSeason: Math.fround(inputs.season),
    uDay: Math.fround(inputs.day),
    'ramp.x': Math.fround(inputs.ramp[0]),
    'ramp.y': Math.fround(inputs.ramp[1]),
    'ramp.z': Math.fround(inputs.ramp[2]),
  };
  const evaluate = (name: string) => {
    if (!Object.hasOwn(glsl, name)) throw new Error(`expression absente : ${name}`);
    variables[name] = evaluateGlsl(glsl[name], variables);
  };
  for (const name of ['temperature', 'amplitude', 'flags', 'south', 'monthly', 'phase', 'most']) {
    evaluate(name);
  }
  if (!(variables.most > 0)) return { share: 0, variables };
  ['x', 'y', 'z', 'w'].forEach((axis, index) => {
    variables[`calendar.${axis}`] = Math.floor(
      Math.fround(Math.fround((inputs.calendar[index] ?? 0) / 255) * 255) + 0.5,
    );
  });
  for (const name of ['summer', 'now', 'level', 'share']) evaluate(name);
  return { share: variables.share, variables };
}
