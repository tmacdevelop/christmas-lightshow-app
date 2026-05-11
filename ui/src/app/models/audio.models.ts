export interface AudioAnalysis {
  duration_ms: number;
  sample_rate: number;
  bpm: number;
  beats_ms: number[];
  rms: number;
}

export interface AudioTrack {
  id: string;
  filename: string;
  analysis: AudioAnalysis;
}
