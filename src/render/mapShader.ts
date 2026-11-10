/**
 * Shader des blocs de carte (tâches 1.7 et 1.8 ; C1, D10 ; REN-10 ; ADR 0010).
 *
 * Il lit le bloc cuit, et la texture de données des saisons à la case du pixel. La
 * température du mois en découle ; au-dessous des seuils de C1 (D9), la neige couvre
 * les terres, la glace l'eau douce (lacs et rivières), la banquise la mer côtière. La
 * couverture remplace le pixel par la palette de saison du biome, choisie selon
 * l'ombrage du pixel : jamais de couleur hors palette (D10). Une couverture partielle
 * se trame (matrice de Bayer), au pixel de près, à la case de loin, pour rester stable
 * au défilement. Les ruisseaux, marqués par la cuisson, ne paraissent que de près.
 *
 * En précision haute, textures comprises : en moyenne précision (16 bits sur bien des
 * téléphones), les pixels au-delà de 2 048 et les bits de données se liraient mal.
 *
 * Les modes de carte (relief, biomes, ressources) remplacent la couleur par celle d'une
 * texture de superposition, une valeur par case, en gardant l'ombrage du relief. En
 * relief, les rivières (pixels d'eau d'une case marquée par l'alpha 128) restent bleues.
 *
 * Écrit en GLSL ES 1.0 : PixiJS y ajoute ce qu'il faut pour WebGL 1 et 2.
 */

export const MAP_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`;

export const MAP_FRAGMENT = /* glsl */ `precision highp float;
precision highp sampler2D;

in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uChunk;
uniform sampler2D uData;
uniform sampler2D uPalettes;
uniform sampler2D uOverlay;

/** Origine du bloc, en cases. */
uniform vec2 uOrigin;
/** Taille du monde, en cases ; nombre de biomes ; indice du biome « rivière ». */
uniform vec2 uWorldCells;
uniform float uBiomes;
uniform float uRiver;
/** Indice d'un biome à neige, dont la palette sert aux terres posées sur l'eau. */
uniform float uSnow;
/** cos(2π (mois − 6,5) / 12), le mois courant étant continu (C1, D8). */
uniform float uSeason;
/** Mode de carte : 0 naturel, 1 couleur par case, 2 ressources. */
uniform float uMode;
/** Couleur des rivières et des ruisseaux. */
uniform vec3 uRiverColor;
/** 1 : trame au pixel, et bits des pixels lisibles (niveau 0) ; 0 : de loin, à la case. */
uniform float uFine;
/** 1 : ruisseaux visibles (de près). */
uniform float uStreams;

float bayer2(vec2 q) {
  return mod(2.0 * q.x + 3.0 * q.y, 4.0);
}

/** Seuil de la matrice de Bayer 4 × 4 au point entier p, dans (0, 1). */
float bayer(vec2 p) {
  vec2 a = mod(p, 2.0);
  vec2 b = mod(floor(p / 2.0), 2.0);
  return (4.0 * bayer2(a) + bayer2(b) + 0.5) / 16.0;
}

void main() {
  vec4 texel = texture(uChunk, vUV);
  vec2 pixel = floor(vUV * 256.0);
  vec2 cell = uOrigin + floor(pixel / 4.0);
  vec2 cellUv = (cell + 0.5) / uWorldCells;
  vec4 data = texture(uData, cellUv);

  float temperature = data.r * 255.0 / 2.0 - 64.0;
  float amplitude = data.g * 255.0 / 8.0;
  float flags = floor(data.b * 255.0 + 0.5);
  float south = mod(flags, 2.0);
  float cover = mod(floor(flags / 16.0), 4.0);
  float waterCell = mod(floor(flags / 64.0), 2.0);
  float forest = floor(flags / 128.0);
  float biome = floor(data.a * 255.0 + 0.5);
  float monthly = temperature + amplitude * uSeason * (south > 0.5 ? -1.0 : 1.0);

  // Au plus près, chaque pixel dit s'il est de terre (bit faible du rouge) et s'il porte
  // un ruisseau (bit faible du vert) ; de loin, la moyenne des mipmaps brouille ces bits,
  // et la case décide. L'alpha porte l'ombrage, que la moyenne respecte.
  float land = 1.0 - waterCell;
  float stream = 0.0;
  if (uFine > 0.5) {
    land = mod(floor(texel.r * 255.0 + 0.5), 2.0);
    stream = mod(floor(texel.g * 255.0 + 0.5), 2.0) * uStreams;
  }
  float shade = texel.a + 0.5;
  vec3 color = texel.rgb;
  bool water = land < 0.5 || stream > 0.5;
  if (stream > 0.5) color = uRiverColor;

  // Couverture du mois (C1, D9) : neige, glace, banquise.
  float snow = clamp((0.5 - monthly) / 3.0, 0.0, 1.0);
  float ice = clamp((-1.0 - monthly) / 3.0, 0.0, 1.0) * 0.9;
  float coverage = 0.0;
  if (!water && cover == 1.0) {
    // Les arbres dépassent : les forêts gardent moins de neige.
    coverage = snow * (forest > 0.5 ? 0.7 : 1.0);
  } else if (!water && (waterCell > 0.5 || cover != 0.0)) {
    // Une terre posée sur l'eau, ou la rive d'un fleuve : la neige y tombe aussi.
    coverage = snow;
    biome = uSnow;
  } else if (water && waterCell < 0.5) {
    // Une rivière ou un ruisseau dans une case de terre : la glace des rivières.
    coverage = ice;
    biome = uRiver;
  } else if (water && cover == 2.0) {
    coverage = ice;
  } else if (water && cover == 3.0) {
    coverage = clamp((-6.0 - monthly) / 4.0, 0.0, 1.0) * 0.85;
  }
  vec2 dither = uFine > 0.5 ? pixel + uOrigin * 4.0 : cell;
  if (coverage > bayer(dither)) {
    float tone = shade < 0.88 ? 0.5 : (shade > 1.12 ? 2.5 : 1.5);
    color = texture(uPalettes, vec2(tone / 3.0, (biome + 0.5) / uBiomes)).rgb;
  }

  if (uMode > 0.5) {
    vec4 overlay = texture(uOverlay, cellUv);
    if (uMode < 1.5) {
      color = overlay.rgb * shade;
      // En relief, les rivières et les ruisseaux visibles restent bleus.
      if (water && waterCell < 0.5 && overlay.a < 0.75) color = uRiverColor;
    } else {
      float grey = dot(color, vec3(0.3, 0.59, 0.11));
      color = mix(vec3(grey), color, 0.35) * 0.8;
      // Un gisement en plein ; une ressource du milieu teinte la carte pâlie (RES-05).
      if (overlay.a > 0.75) color = overlay.rgb;
      else if (overlay.a > 0.25) color = mix(color, overlay.rgb, 0.7);
    }
  }
  finalColor = vec4(color, 1.0);
}
`;
