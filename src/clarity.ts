import { SlimError } from './opc.js';

export type PresetName = 'hq' | 'balanced' | 'max';

export interface Preset {
  /** Target pixel density at the size each image is displayed. */
  ppi: number;
  jpegQuality: number;
  /** PNG palette quantisation quality; 0 means lossless PNG. */
  pngQuality: number;
}

export const DEFAULT_CLARITY = 60;

/** Clarity is the one knob users turn; these points define what it means, with straight lines in between. */
const CLARITY_CURVE: readonly (readonly [clarity: number, ppi: number, jpeg: number, png: number])[] = [
  [1, 50, 35, 40],
  [30, 96, 68, 70],
  [60, 150, 80, 90],
  [85, 220, 88, 100],
  [100, 330, 95, 100],
];
/** From this clarity up, PNG stays lossless instead of being reduced to a palette. */
const LOSSLESS_PNG_FROM = 85;

export function settingsForClarity(clarity: number): Preset {
  if (!(clarity >= 1 && clarity <= 100)) throw new SlimError('error.clarityRange');
  let upper = CLARITY_CURVE.findIndex((point) => point[0] >= clarity);
  if (upper <= 0) upper = 1;
  const low = CLARITY_CURVE[upper - 1]!;
  const high = CLARITY_CURVE[upper]!;
  const t = (clarity - low[0]) / (high[0] - low[0]);
  const between = (index: 1 | 2 | 3) => Math.round(low[index] + (high[index] - low[index]) * t);
  return {
    ppi: between(1),
    jpegQuality: between(2),
    pngQuality: clarity >= LOSSLESS_PNG_FROM ? 0 : between(3),
  };
}

/** Named shortcuts for three points on the clarity scale. */
export const PRESET_CLARITY: Record<PresetName, number> = { hq: 85, balanced: 60, max: 30 };

export const PRESETS: Record<PresetName, Preset> = {
  hq: settingsForClarity(PRESET_CLARITY.hq),
  balanced: settingsForClarity(PRESET_CLARITY.balanced),
  max: settingsForClarity(PRESET_CLARITY.max),
};
