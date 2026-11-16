/** Bölüm geçişlerinde yavaşça dönüşen renk paletleri (doğrusal RGB 0..1). */
export interface Palette {
  skyTop: [number, number, number];
  skyLow: [number, number, number];
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
}

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  const s = (v: number) => Math.pow(v / 255, 2.2);
  return [s((n >> 16) & 255), s((n >> 8) & 255), s(n & 255)];
};

export const PALETTES: Palette[] = [
  { skyTop: hex('#04060f'), skyLow: hex('#122340'), a: hex('#5fe3b0'), b: hex('#3aa0d8'), c: hex('#9b7bea') }, // kuzey yeşili
  { skyTop: hex('#07040f'), skyLow: hex('#2a1838'), a: hex('#e58fd1'), b: hex('#7d6cf0'), c: hex('#ffd2a6') }, // gül/menekşe
  { skyTop: hex('#020a0d'), skyLow: hex('#0f2e33'), a: hex('#7ff0e0'), b: hex('#46c2a0'), c: hex('#d9f59a') }, // camgöbeği
  { skyTop: hex('#0a0607'), skyLow: hex('#33201a'), a: hex('#f3b36a'), b: hex('#e06d6d'), c: hex('#ffe2b8') }, // kehribar
  { skyTop: hex('#03040a'), skyLow: hex('#151d3d'), a: hex('#9ec5ff'), b: hex('#6a7dff'), c: hex('#e7e3ff') }, // buz mavisi
  { skyTop: hex('#050a06'), skyLow: hex('#1b2c1c'), a: hex('#b4f07a'), b: hex('#5fc98b'), c: hex('#f0e68c') }, // çayır
];

export function paletteAt(from: number, to: number, mix: number): Palette {
  const A = PALETTES[((from % PALETTES.length) + PALETTES.length) % PALETTES.length];
  const B = PALETTES[((to % PALETTES.length) + PALETTES.length) % PALETTES.length];
  const l = (x: [number, number, number], y: [number, number, number]): [number, number, number] =>
    [x[0] + (y[0] - x[0]) * mix, x[1] + (y[1] - x[1]) * mix, x[2] + (y[2] - x[2]) * mix];
  return { skyTop: l(A.skyTop, B.skyTop), skyLow: l(A.skyLow, B.skyLow), a: l(A.a, B.a), b: l(A.b, B.b), c: l(A.c, B.c) };
}

/** Canvas 2D için sRGB dizesi. */
export function css(c: [number, number, number], alpha = 1, gain = 1): string {
  const s = (v: number) => Math.round(255 * Math.pow(Math.min(1, Math.max(0, v * gain)), 1 / 2.2));
  return `rgba(${s(c[0])},${s(c[1])},${s(c[2])},${alpha})`;
}
