import { useEffect } from 'react';

/** Sizes the app to the visual viewport, so the mobile keyboard shrinks it rather than covering it. */
export function useAppViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      document.documentElement.style.setProperty(
        '--app-height',
        `${viewport?.height ?? window.innerHeight}px`
      );
      // Mobile browsers can pan the visual viewport to reveal a focused input.
      // Keep the app's top edge visible while its height follows the keyboard.
      document.documentElement.style.setProperty('--app-top', `${viewport?.offsetTop ?? 0}px`);
    };
    resize();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
      document.documentElement.style.removeProperty('--app-height');
      document.documentElement.style.removeProperty('--app-top');
    };
  }, []);
}
