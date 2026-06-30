// Instrument palette + per-constellation hues + the turbo scientific colormap.
// One source of truth shared by the globe, skyplots, and CSS-driving code.

export type Constellation = "GPS" | "GAL" | "GLO" | "BDS";

// Per-constellation hue, tuned to read distinctly on a near-black globe.
export const CONSTELLATION: Record<
  Constellation,
  { name: string; full: string; hex: number; css: string }
> = {
  GPS: { name: "GPS", full: "GPS / NAVSTAR", hex: 0xc8f7ff, css: "#c8f7ff" },
  GAL: { name: "GAL", full: "GALILEO", hex: 0xffb347, css: "#ffb347" },
  GLO: { name: "GLO", full: "GLONASS", hex: 0xff6b6b, css: "#ff6b6b" },
  BDS: { name: "BDS", full: "BEIDOU", hex: 0x5ef2a0, css: "#5ef2a0" },
};

export const ACCENT = {
  cyan: "#35e0d8",
  cyanHex: 0x35e0d8,
  amber: "#ffb347",
  amberHex: 0xffb347,
  ink: "#05070d",
  panel: "#070a12",
  grid: "#0e2a32",
};

// Google "turbo" colormap (Mikhailov 2019), a perceptually ordered rainbow that
// reads as a scientific TEC scale. Polynomial fit, x in [0, 1].
export function turbo(x: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, x));
  const r =
    34.61 +
    t * (1172.33 - t * (10793.56 - t * (33300.12 - t * (38394.49 - t * 14825.05))));
  const g =
    23.31 +
    t * (557.33 + t * (1225.33 - t * (3574.96 - t * (1073.77 + t * 707.56))));
  const b =
    27.2 +
    t * (3211.1 - t * (15327.97 - t * (27814.0 - t * (22569.18 - t * 6838.66))));
  return [clamp255(r), clamp255(g), clamp255(b)];
}

function clamp255(v: number): number {
  return Math.round(Math.min(255, Math.max(0, v)));
}

export function turboCss(x: number): string {
  const [r, g, b] = turbo(x);
  return `rgb(${r},${g},${b})`;
}
