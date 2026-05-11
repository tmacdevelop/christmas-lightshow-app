/** Connection state for the frame stream. */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** A decoded frame: one entry per pixel as `[r, g, b]`. */
export type DecodedFrame = Uint8Array;
