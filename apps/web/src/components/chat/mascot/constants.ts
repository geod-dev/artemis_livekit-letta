export type Mode = 'hidden' | 'loading' | 'welcome' | 'waiting' | 'writing' | 'idle';
export type Box = { x: number; y: number; s: number };

export const INLINE_SIZE = 23;
export const GAP_AFTER_TEXT = 6;
export const MAX_EYE_SHIFT = 4;
export const MOODS = ['neutral', 'curious', 'pleased'] as const;
export const SLEEPY_AFTER = 12_000;
/** Frames of unchanged scroll required before the mascot travels. */
export const STABLE_FRAMES = 3;
