export type EffectKind = 'solid' | 'fade' | 'chase' | 'rainbow' | 'reactive';

export type PlaybackMode = 'live' | 'sequence';

export interface EffectInfo {
  kind: EffectKind;
  uses_color: boolean;
}

export interface ColorPayload {
  r: number;
  g: number;
  b: number;
  hex: string;
}

export interface PlaybackInfo {
  mode: PlaybackMode;
  sequence_id: string | null;
  sequence_name: string | null;
  position_ms: number;
  duration_ms: number;
  looping: boolean;
}

export interface ShowStatus {
  playing: boolean;
  brightness: number;
  color: ColorPayload;
  effect: EffectKind;
  playback: PlaybackInfo;
  active_layout_id: string | null;
  pixel_count: number;
}

export interface EffectsResponse {
  available: EffectInfo[];
  active: EffectKind;
}
