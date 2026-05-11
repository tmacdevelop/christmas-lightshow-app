import { EffectKind } from './show.models';

export interface ClipColor {
  r: number;
  g: number;
  b: number;
}

export interface Clip {
  id: string;
  start_ms: number;
  duration_ms: number;
  kind: EffectKind;
  color: ClipColor;
  /**
   * Optional per-pixel pattern. When set, the engine paints these colors
   * pixel-by-pixel for the whole clip duration (tiling if shorter than the
   * strip) and ignores `kind`. Omit to use the effect.
   */
  pattern?: ClipColor[];
}

export interface Sequence {
  id: string;
  name: string;
  duration_ms: number;
  clips: Clip[];
}
