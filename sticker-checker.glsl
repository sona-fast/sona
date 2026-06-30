/** @resolution */
uniform vec2 u_resolution;

/**
 * @label Square Size
 * @default 14
 * @range 4, 48
 */
uniform float u_size;

/**
 * @label Color A
 * @color
 * @default #1f1d33
 */
uniform vec3 u_colorA;

/**
 * @label Color B
 * @color
 * @default #191730
 */
uniform vec3 u_colorB;

void main() {
  vec2 cell = floor(gl_FragCoord.xy / u_size);
  float check = mod(cell.x + cell.y, 2.0);
  vec3 color = mix(u_colorA, u_colorB, check);
  gl_FragColor = vec4(color, 1.0);
}
