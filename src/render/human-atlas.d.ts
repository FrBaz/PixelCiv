/** Atlas des humains des planches, rangé au build par tools/human-atlas.ts (ADR 0016). */
declare module 'virtual:human-atlas' {
  type BodyKind = 'female' | 'male' | 'child' | 'baby';
  const atlas: {
    readonly width: number;
    readonly height: number;
    /** Rôles, un octet par pixel, en base64. */
    readonly roles: string;
    /** Six nombres par motif : x, y, largeur, hauteur, pieds (abscisse, ordonnée). */
    readonly motifs: readonly number[];
    readonly index: readonly number[];
    readonly bodies: readonly string[];
    readonly kinds: readonly BodyKind[];
    readonly levels: readonly {
      readonly factor: number;
      readonly rows: number;
      readonly variants: readonly number[];
    }[];
    /** Images rangées de chaque animation, et le rang dans la planche de chacune. */
    readonly animations: readonly {
      readonly id: string;
      readonly frames: number;
      readonly ranks: readonly number[];
      readonly steps?: number;
      readonly frameMs?: number;
      readonly loop: boolean;
    }[];
    readonly regions: readonly string[];
    readonly hairRegion: number;
    readonly kept: readonly string[];
    readonly eyes: readonly number[];
    readonly skin: readonly string[];
    readonly under: readonly string[];
    readonly underRegions: Readonly<Record<BodyKind, readonly string[]>>;
    readonly credit: { readonly title: string; readonly author: string; readonly url: string };
  };
  export default atlas;
}
