import { type RefObject, type SVGProps, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuiState } from '@assistant-ui/react';
import { cn } from '@/lib/shadcn/utils';

/**
 * Artemis's mascot lives in a shared viewport overlay outside the scrolling content.
 * Anchors are measured in that overlay's visible coordinates, so switching
 * conversations never makes its animated position extend the scroll height.
 *
 * - hidden: while the app opens on a conversation, until it is on screen.
 * - new chat: the `data-mascot-anchor="welcome"` box above the composer;
 *   eyes follow the mouse.
 * - waiting for a reply (from the moment a message is sent): the
 *   `data-mascot-anchor="waiting"` box where the reply will start; it spins
 *   on itself.
 * - writing: right after the last character of the reply, glancing at the
 *   new text.
 * - done: after the last word of the last assistant message; eyes follow the
 *   mouse.
 *
 * When there is no room after the last word, it drops below the reply (below
 * its `data-mascot-previews` link cards, if any), and the message gets
 * `data-mascot-wrapped` so its action bar can make room beside it.
 * Once the reply is done, the mascot itself then has the `mascot-wrapped` class.
 *
 * Geometry (100-unit canvas): ring stroke 12.5 drawn inside the edge, eyes
 * 16×35 pills centred at x=37/63, y=50. The eyes clear the ring by ~13 units;
 * they never move more than MAX_EYE_SHIFT, so they never touch it.
 */

type Mode = 'hidden' | 'welcome' | 'waiting' | 'writing' | 'idle';
type Box = { x: number; y: number; s: number };

const INLINE_SIZE = 23;
const GAP_AFTER_TEXT = 6;
const MAX_EYE_SHIFT = 4;
/** Frames of unchanged scroll required before the mascot travels. */
const STABLE_FRAMES = 3;

/** Shared Artemis mark for the app header and animated chat mascot. */
export function MascotMark({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-2 -2 104 104" {...props}>
      <circle cx="50" cy="50" r="43.75" fill="none" stroke="currentColor" strokeWidth="12.5" />
      {children ?? (
        <g fill="currentColor">
          <rect x="29" y="32.5" width="16" height="35" rx="8" />
          <rect x="55" y="32.5" width="16" height="35" rx="8" />
        </g>
      )}
    </svg>
  );
}

export function Mascot({
  viewportRef,
  easterEggEnabled = false,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  easterEggEnabled?: boolean;
}) {
  const mode = useAuiState((s): Mode => {
    const messages = s.thread.messages;
    if (messages.length === 0) return s.thread.isLoading ? 'hidden' : 'welcome';
    if (!s.thread.isRunning) return 'idle';
    const last = messages.at(-1);
    const writing =
      last?.role === 'assistant' &&
      last.content.some((part) => part.type === 'text' && part.text.trim().length > 0);
    return writing ? 'writing' : 'waiting';
  });

  const threadId = useAuiState((s) => s.threadListItem.id);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const rootRef = useRef<HTMLDivElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [showXMarks, setShowXMarks] = useState(false);
  const xMarksTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (xMarksTimer.current !== null) window.clearTimeout(xMarksTimer.current);
    },
    []
  );

  const showEasterEgg = () => {
    if (!easterEggEnabled) return;
    setShowXMarks(true);
    if (xMarksTimer.current !== null) window.clearTimeout(xMarksTimer.current);
    xMarksTimer.current = window.setTimeout(() => setShowXMarks(false), 3000);
  };

  useEffect(() => {
    const root = rootRef.current;
    const container = root?.parentElement;
    const viewport = viewportRef.current;
    if (!root || !container || !viewport) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Overlay coordinates persist across thread changes, even as content shrinks.
    let pos: Box | null = null;
    // Allow automatic scrolling to settle before gliding to a new anchor.
    let stableFrames = 0;
    let lastScrollTop = viewport.scrollTop;
    let lastThreadId = threadIdRef.current;
    const eye = { x: 0, y: 0 };
    let mouse: { x: number; y: number } | null = null;
    const onPointerMove = (e: PointerEvent) => {
      mouse = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    let wrappedMessage: Element | null = null;
    const markWrapped = (message: Element | null) => {
      if (message === wrappedMessage) return;
      wrappedMessage?.removeAttribute('data-mascot-wrapped');
      message?.setAttribute('data-mascot-wrapped', '');
      wrappedMessage = message;
    };

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const settingsAnchor = document.querySelector<HTMLElement>('[data-mascot-anchor="settings"]');
      container.style.zIndex = settingsAnchor ? '60' : '10';
      const switched = threadIdRef.current !== lastThreadId;
      const scrollDelta = viewport.scrollTop - lastScrollTop;
      stableFrames = !switched && scrollDelta === 0 ? stableFrames + 1 : 0;
      // Follow ordinary scrolling, but retain the rendered position on a switch.
      if (pos && !settingsAnchor && !switched && scrollDelta !== 0) {
        pos = clampToViewport({ ...pos, y: pos.y - scrollDelta }, container, viewport);
      }
      lastScrollTop = viewport.scrollTop;
      lastThreadId = threadIdRef.current;

      let wrapped: Element | null = null;
      const settingsBounds = settingsAnchor?.getBoundingClientRect();
      const spot = settingsBounds
        ? {
            box: toBox(container, settingsBounds.left, settingsBounds.top, settingsBounds.width),
            mode: 'idle' as const,
          }
        : findSpot(viewport, container, modeRef.current, pos !== null, (message) => {
            wrapped = message;
          });
      markWrapped(wrapped);
      if (spot === 'hold') return; // its next spot is not rendered yet: stay put
      if (spot === 'offscreen') {
        root.style.opacity = '0';
        // Reappear at the message anchor instead of gliding from a clamped edge.
        pos = null;
        return;
      }
      if (!spot) {
        root.style.opacity = '0';
        return;
      }
      root.style.opacity = '1';
      // The effective mode drives the CSS animation (spin while waiting).
      if (root.dataset.mode !== spot.mode) root.dataset.mode = spot.mode;
      root.classList.toggle('mascot-wrapped', spot.mode === 'idle' && wrappedMessage !== null);
      const target = settingsAnchor ? spot.box : clampToViewport(spot.box, container, viewport);

      pos ??= { ...target };
      const ready = settingsAnchor !== null || stableFrames >= STABLE_FRAMES;
      if (ready) {
        // A plain ease-out glide (each frame covers a fixed share of the
        // remaining distance): it never overshoots, and snaps to whole pixels
        // at the end so there is no shimmer at rest.
        for (const key of ['x', 'y', 's'] as const) {
          pos[key] += (target[key] - pos[key]) * (reduceMotion ? 1 : 0.2);
          if (Math.abs(target[key] - pos[key]) < 0.3) pos[key] = target[key];
        }
      }

      root.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      root.style.width = `${pos.s}px`;
      root.style.height = `${pos.s}px`;

      // Eyes: a glance at the new text while writing, centred while spinning,
      // otherwise a subtle look towards the pointer.
      let ex = 0;
      let ey = 0;
      if (spot.mode === 'writing') {
        ex = -MAX_EYE_SHIFT;
        ey = 1;
      } else if (spot.mode !== 'waiting' && mouse) {
        const origin = container.getBoundingClientRect();
        const dx = mouse.x - (origin.left + pos.x + pos.s / 2);
        const dy = mouse.y - (origin.top + pos.y + pos.s / 2);
        const distance = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, distance / 240) * MAX_EYE_SHIFT;
        ex = (dx / distance) * reach;
        ey = (dy / distance) * reach;
      }
      eye.x += (ex - eye.x) * (reduceMotion ? 1 : 0.15);
      eye.y += (ey - eye.y) * (reduceMotion ? 1 : 0.15);
      eyesRef.current?.setAttribute(
        'transform',
        `translate(${eye.x.toFixed(2)} ${eye.y.toFixed(2)})`
      );
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointerMove);
      markWrapped(null);
    };
  }, [viewportRef]);

  const blinking = useRandomBlink();

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-10 overflow-hidden">
      <div
        ref={rootRef}
        aria-hidden={!easterEggEnabled}
        role={easterEggEnabled ? 'button' : undefined}
        tabIndex={easterEggEnabled ? 0 : undefined}
        aria-label={easterEggEnabled ? 'Click for a surprise' : undefined}
        onClick={showEasterEgg}
        onKeyDown={(event) => {
          if (easterEggEnabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            showEasterEgg();
          }
        }}
        data-mode={mode}
        className={cn(
          'group/mascot text-mascot absolute top-0 left-0 z-10 transition-opacity duration-200',
          easterEggEnabled ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none'
        )}
        style={{ width: 0, height: 0, opacity: 0 }}
      >
        <MascotMark className="group-data-[mode=waiting]/mascot:animate-mascot-turn size-full">
          <g ref={eyesRef}>
            {showXMarks ? (
              <g fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round">
                <path d="m32 41 10 18m0-18L32 59m26-18 10 18m0-18L58 59" />
              </g>
            ) : (
              <g className={blinking ? 'mascot-blink' : undefined}>
                <rect x="29" y="32.5" width="16" height="35" rx="8" fill="currentColor" />
                <rect x="55" y="32.5" width="16" height="35" rx="8" fill="currentColor" />
              </g>
            )}
          </g>
        </MascotMark>
      </div>
    </div>,
    document.body
  );
}

/** A box in the container's coordinates, on whole pixels. */
function toBox(container: HTMLElement, x: number, y: number, size: number): Box {
  const origin = container.getBoundingClientRect();
  return { x: Math.round(x - origin.left), y: Math.round(y - origin.top), s: Math.round(size) };
}

/** Offscreen anchors get a visible destination instead of blocking movement. */
function clampToViewport(box: Box, overlay: HTMLElement, viewport: HTMLElement): Box {
  const origin = overlay.getBoundingClientRect();
  const v = viewport.getBoundingClientRect();
  const left = v.left + viewport.clientLeft - origin.left;
  const top = v.top + viewport.clientTop - origin.top;
  const size = Math.min(box.s, viewport.clientWidth, viewport.clientHeight);
  return {
    x: Math.max(left, Math.min(box.x, left + viewport.clientWidth - size)),
    y: Math.max(top, Math.min(box.y, top + viewport.clientHeight - size)),
    s: size,
  };
}

/**
 * Where the mascot should be, in the overlay's coordinates, and the mode it
 * is really in. 'hold' means its next spot is not rendered yet. `onWrap`
 * receives the message it dropped below, if any.
 */
function findSpot(
  viewport: HTMLElement,
  container: HTMLElement,
  mode: Mode,
  placed: boolean,
  onWrap: (message: Element) => void
): { box: Box; mode: Mode } | 'hold' | 'offscreen' | null {
  const at = (x: number, y: number, size: number, as: Mode = mode) => ({
    box: toBox(container, x, y, size),
    mode: as,
  });
  const visibleAt = (x: number, y: number, size: number, as: Mode = mode) => {
    const rect = viewport.getBoundingClientRect();
    const left = rect.left + viewport.clientLeft;
    const top = rect.top + viewport.clientTop;
    const inside =
      x >= left &&
      y >= top &&
      x + size <= left + viewport.clientWidth &&
      y + size <= top + viewport.clientHeight;
    return inside ? at(x, y, size, as) : 'offscreen';
  };
  if (mode === 'hidden') return null;
  if (mode === 'welcome') {
    const anchor = viewport.querySelector('[data-mascot-anchor="welcome"]');
    // Welcome screen not rendered yet: stay where it is (hidden until placed).
    if (!anchor) return placed ? 'hold' : null;
    const r = anchor.getBoundingClientRect();
    return visibleAt(r.left, r.top, r.width);
  }

  const waiting = viewport.querySelector('[data-mascot-anchor="waiting"]');
  if (waiting) {
    const r = waiting.getBoundingClientRect();
    return visibleAt(r.left, r.top + (r.height - INLINE_SIZE) / 2, INLINE_SIZE, 'waiting');
  }

  const messages = viewport.querySelectorAll('[data-mascot-message]');
  const last = messages[messages.length - 1];
  if (!last) return null;
  const end = lastCharacterRect(last);
  if (end) {
    const bounds = last.getBoundingClientRect();
    if (end.right + GAP_AFTER_TEXT + INLINE_SIZE > bounds.right) {
      onWrap(last);
      // Link previews come between the text and the action bar: go below them,
      // keeping the same offset from the action bar as below plain text.
      const previews = last.parentElement?.querySelector(':scope > [data-mascot-previews]');
      const shift = previews ? previews.getBoundingClientRect().bottom - bounds.bottom : 0;
      return visibleAt(bounds.left, end.bottom + 2 + shift, INLINE_SIZE);
    }
    return visibleAt(
      end.right + GAP_AFTER_TEXT,
      end.top + end.height / 2 - INLINE_SIZE / 2,
      INLINE_SIZE
    );
  }
  const r = last.getBoundingClientRect();
  return visibleAt(r.left, r.bottom - INLINE_SIZE, INLINE_SIZE);
}

/** The box of the last visible character in an element (skipping buttons and screen-reader text). */
function lastCharacterRect(element: Element): DOMRect | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent) return NodeFilter.FILTER_REJECT;
      const ignored = parent.closest('button, .sr-only, [aria-hidden="true"]');
      // Modal libraries may aria-hide a visible app ancestor while a portal is
      // open. Ignore only hidden elements inside the message being measured.
      if (ignored && ignored !== element && element.contains(ignored)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
  if (!last) return null;
  const text = last.textContent ?? '';
  const index = text.trimEnd().length - 1;
  if (index < 0) return null;
  const range = document.createRange();
  range.setStart(last, index);
  range.setEnd(last, index + 1);
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

/** Blinks at random intervals, sometimes twice in a row. */
function useRandomBlink(): boolean {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    let timer: number;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        setBlinking(true);
        timer = window.setTimeout(() => {
          setBlinking(false);
          schedule(Math.random() < 0.2 ? 180 : 2200 + Math.random() * 4300);
        }, 150);
      }, delay);
    };
    schedule(1500 + Math.random() * 3000);
    return () => window.clearTimeout(timer);
  }, []);
  return blinking;
}
