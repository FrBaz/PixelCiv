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
