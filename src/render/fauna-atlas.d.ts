/** Atlas du gibier, rangé au build par tools/fauna-atlas.ts (ADR 0018). */
declare module 'virtual:fauna-atlas' {
  const atlas: {
    readonly width: number;
    readonly height: number;
    /** Rôles, un octet par pixel, en base64. */
    readonly roles: string;
    /** Six nombres par motif : x, y, largeur, hauteur, pieds (abscisse, ordonnée). */
    readonly motifs: readonly number[];
    /** Formes (« deer », « stag »…) et animations, dans l'ordre de l'index. */
    readonly forms: readonly string[];
    readonly animations: readonly string[];
    /** Images de chaque animation, les mêmes pour chaque forme. */
    readonly frames: readonly number[];
    readonly levels: number;
    /** Premier motif de (forme, jeune, animation, niveau), puis une image après l'autre ; −1 sans motif. */
    readonly index: readonly number[];
  };
  export default atlas;
}
