/** Aides à l'écriture des shaders de la carte (src/render/mapShader.ts, src/render/waves.ts). */

/** Nombre écrit en littéral flottant de GLSL : 3 devient « 3.0 ». */
export function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
