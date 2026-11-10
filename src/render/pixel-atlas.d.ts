/** Atlas des sources pixel art, rangé au build par tools/pixel-atlas.ts (AST-04). */
declare module 'virtual:pixel-atlas' {
  const atlas: {
    readonly width: number;
    readonly height: number;
    /** Code de rôle de chaque pixel, ligne par ligne (tools/pixel-atlas.ts). */
    readonly roles: readonly number[];
    readonly frames: Readonly<
      Record<
        string,
        { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
      >
    >;
  };
  export default atlas;
}
