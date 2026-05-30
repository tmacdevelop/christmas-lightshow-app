import { WritableSignal, effect, signal } from '@angular/core';

/**
 * A `signal` whose value is mirrored to `localStorage` under `key`. On
 * creation it hydrates from any previously stored value; thereafter every
 * change is written back via an `effect`.
 *
 * Must be created within an Angular injection context (e.g. a service/
 * component field initializer) because it uses `effect`.
 *
 * Reads/writes are defensively guarded so SSR (no `window`), private-mode
 * quota errors, or corrupt JSON never throw — they simply fall back to the
 * provided `initial` value.
 */
export interface PersistedSignalOptions<T> {
  /**
   * Validate/normalize a parsed value before it is accepted. Return
   * `undefined` to reject the stored value and use `initial` instead. Useful
   * for clamping numbers or guarding against shape drift.
   */
  sanitize?: (value: unknown) => T | undefined;
}

export function persistedSignal<T>(
  key: string,
  initial: T,
  options: PersistedSignalOptions<T> = {},
): WritableSignal<T> {
  const stored = readStored<T>(key, options.sanitize);
  const sig = signal<T>(stored === undefined ? initial : stored);

  effect(() => {
    const value = sig();
    if (!hasStorage()) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage disabled — non-fatal.
    }
  });

  return sig;
}

function readStored<T>(
  key: string,
  sanitize?: (value: unknown) => T | undefined,
): T | undefined {
  if (!hasStorage()) return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return sanitize ? sanitize(parsed) : (parsed as T);
  } catch {
    return undefined;
  }
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

/** Clamp helper for numeric `sanitize` callbacks. */
export function clampNumber(min: number, max: number) {
  return (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.max(min, Math.min(max, value));
  };
}
