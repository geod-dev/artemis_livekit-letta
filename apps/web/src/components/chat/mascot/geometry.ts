import { type Box, GAP_AFTER_TEXT, INLINE_SIZE, type Mode } from './constants';

/** A box in the container's coordinates, on whole pixels. */
export function toBox(container: HTMLElement, x: number, y: number, size: number): Box {
  const origin = container.getBoundingClientRect();
  return { x: Math.round(x - origin.left), y: Math.round(y - origin.top), s: Math.round(size) };
}

/** Offscreen anchors get a visible destination instead of blocking movement. */
export function clampToViewport(box: Box, overlay: HTMLElement, viewport: HTMLElement): Box {
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
export function findSpot(
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
  if (mode === 'welcome' || mode === 'loading') {
    const anchor = viewport.querySelector(
      `[data-mascot-anchor="${mode === 'loading' ? 'loading' : 'welcome'}"]`
    );
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
export function lastCharacterRect(element: Element): DOMRect | null {
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
