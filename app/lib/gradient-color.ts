/**
 * Neon gradient color utility.
 *
 * Defines the same gradient used in the color picker bar and provides helpers
 * to sample a hex color at any position (0-1) and to find the closest position
 * for a given hex color.
 */

/** Gradient stops in order — matches the CSS linear-gradient in GradientColorPicker */
export const GRADIENT_STOPS: [number, number, number][] = [
  [0x00, 0xf0, 0xff], // cyan
  [0xa0, 0xf0, 0xff], // ice
  [0x00, 0xc8, 0xff], // sky
  [0x4d, 0x4d, 0xff], // electric
  [0x7b, 0x61, 0xff], // indigo
  [0xbf, 0x5a, 0xf2], // violet
  [0xff, 0x00, 0xaa], // magenta
  [0xff, 0x3d, 0x8a], // rose
  [0xff, 0x6b, 0x6b], // coral
  [0xdc, 0x14, 0x3c], // crimson
  [0xff, 0x5e, 0x00], // plasma
  [0xff, 0xb8, 0x00], // amber
  [0xff, 0xd7, 0x00], // gold
  [0xcc, 0xff, 0x00], // acid
  [0x39, 0xff, 0x14], // lime
  [0x00, 0xe5, 0xbf], // teal
];

/** The CSS gradient string for use in backgrounds */
export const GRADIENT_CSS =
  'linear-gradient(90deg, #00f0ff, #a0f0ff, #00c8ff, #4d4dff, #7b61ff, #bf5af2, #ff00aa, #ff3d8a, #ff6b6b, #dc143c, #ff5e00, #ffb800, #ffd700, #ccff00, #39ff14, #00e5bf)';

/** Sample a hex color at position t (0-1) along the gradient */
export function gradientColorAt(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const n = GRADIENT_STOPS.length - 1;
  const idx = clamped * n;
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, n);
  const frac = idx - lo;

  const [r1, g1, b1] = GRADIENT_STOPS[lo];
  const [r2, g2, b2] = GRADIENT_STOPS[hi];

  const r = Math.round(r1 + (r2 - r1) * frac);
  const g = Math.round(g1 + (g2 - g1) * frac);
  const b = Math.round(b1 + (b2 - b1) * frac);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Parse a hex color string to [r, g, b] */
function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Find the gradient position (0-1) closest to a given hex color */
export function gradientPositionOf(hex: string): number {
  const [tr, tg, tb] = parseHex(hex);
  let bestPos = 0;
  let bestDist = Infinity;
  // Sample 1000 points along the gradient
  for (let i = 0; i <= 1000; i++) {
    const t = i / 1000;
    const [r, g, b] = parseHex(gradientColorAt(t));
    const dist = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestPos = t;
    }
  }
  return bestPos;
}

/** Map from old token names to hex values */
export const TOKEN_TO_HEX: Record<string, string> = {
  'neon-cyan': '#00f0ff',
  'neon-magenta': '#ff00aa',
  'neon-violet': '#bf5af2',
  'neon-amber': '#ffb800',
  'neon-lime': '#39ff14',
  'neon-coral': '#ff6b6b',
  'neon-electric': '#4d4dff',
  'neon-plasma': '#ff5e00',
  'neon-ice': '#a0f0ff',
  'neon-rose': '#ff3d8a',
  'neon-teal': '#00e5bf',
  'neon-gold': '#ffd700',
  'neon-indigo': '#7b61ff',
  'neon-acid': '#ccff00',
  'neon-crimson': '#dc143c',
  'neon-sky': '#00c8ff',
};

/** Resolve a color value — if it's an old token name, convert to hex; otherwise pass through */
export function resolveColor(color: string): string {
  return TOKEN_TO_HEX[color] ?? color;
}
