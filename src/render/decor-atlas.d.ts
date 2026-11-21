/** Atlas du décor, rangé au build par tools/decor-atlas.ts (ADR 0017). */
declare module 'virtual:decor-atlas' {
  const atlas: {
    readonly width: number;
    readonly height: number;
    /** Rôles, un octet par pixel, en base64. */
    readonly roles: string;
    /** Six nombres par motif : x, y, largeur, hauteur, pieds (abscisse, ordonnée). */
    readonly motifs: readonly number[];
    /** Nom de chaque source (« forme-variante ») ; le motif du niveau l est source × niveaux + l. */
    readonly names: readonly string[];
    /** Sources de chaque forme, dans l'ordre de leurs variantes. */
    readonly forms: Readonly<Record<string, readonly number[]>>;
    readonly levels: number;
  };
  export default atlas;
}
