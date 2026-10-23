import { type RefObject, useEffect, useState } from 'react';

/** Blinks at random intervals, sometimes twice in a row. */
export function useRandomBlink(rootRef: RefObject<HTMLDivElement | null>): boolean {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: number;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        setBlinking(
          !motionQuery.matches &&
            document.visibilityState === 'visible' &&
            document.hasFocus() &&
            rootRef.current?.dataset.mood !== 'sleepy'
        );
        timer = window.setTimeout(() => {
          setBlinking(false);
          schedule(Math.random() < 0.18 ? 240 : 2200 + Math.random() * 4300);
        }, 170);
      }, delay);
    };
    schedule(1500 + Math.random() * 3000);
    return () => window.clearTimeout(timer);
  }, [rootRef]);
  return blinking;
}
