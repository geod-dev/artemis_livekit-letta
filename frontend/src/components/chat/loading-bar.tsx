import { useEffect, useRef } from 'react';

/**
 * A thin cyan bar across the top of the window while the next page loads: it
 * fills towards the end without reaching it, then completes and fades out
 * once the page is there.
 */
export function LoadingBar({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    if (active) {
      // Restart from empty (without transition), then creep forward.
      bar.style.transition = 'none';
      bar.style.opacity = '1';
      bar.style.transform = 'scaleX(0)';
      void bar.offsetWidth;
      bar.style.transition = 'transform 10s cubic-bezier(0.05, 0.8, 0.1, 1)';
      bar.style.transform = 'scaleX(0.9)';
    } else if (bar.style.opacity === '1') {
      bar.style.transition = 'transform 200ms ease-out, opacity 250ms ease 200ms';
      bar.style.transform = 'scaleX(1)';
      bar.style.opacity = '0';
    }
  }, [active]);

  return (
    <div
      ref={ref}
      aria-hidden
      className="bg-primary pointer-events-none fixed inset-x-0 top-0 z-50 h-[3px] origin-left"
      style={{ opacity: 0, transform: 'scaleX(0)' }}
    />
  );
}
