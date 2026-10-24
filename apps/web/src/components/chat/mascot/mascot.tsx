import { type RefObject, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuiState } from '@assistant-ui/react';
import { useAgent } from '@livekit/components-react';
import { MascotElementContext, useChatThread } from '@/components/chat/context';
import {
  type Box,
  MAX_EYE_SHIFT,
  MOODS,
  type Mode,
  SLEEPY_AFTER,
  STABLE_FRAMES,
} from '@/components/chat/mascot/constants';
import { clampToViewport, findSpot, toBox } from '@/components/chat/mascot/geometry';
import { MascotMark } from '@/components/chat/mascot/mascot-mark';
import { useRandomBlink } from '@/hooks/use-random-blink';
import type { RecordingStatus } from '@/hooks/use-voice-recorder';
import { cn } from '@/lib/shadcn/utils';

/**
 * Artemis's mascot lives in a shared viewport overlay outside the scrolling content.
 * Anchors are measured in that overlay's visible coordinates, so switching
 * conversations never makes its animated position extend the scroll height.
 *
 * - loading: a reserved anchor while the initial history arrives.
 * - new chat: the `data-mascot-anchor="welcome"` box above the composer;
 *   eyes follow the mouse.
 * - waiting for a reply (from the moment a message is sent): the
 *   `data-mascot-anchor="waiting"` box where the reply will start; it moves
 *   with a slow, thoughtful tilt.
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

export function Mascot({
  viewportRef,
  easterEggEnabled = false,
  recordingStatus = 'idle',
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  easterEggEnabled?: boolean;
  recordingStatus?: RecordingStatus;
}) {
  const agent = useAgent();
  const { callButton, error } = useChatThread();
  const mode = useAuiState((s): Mode => {
    const messages = s.thread.messages;
    if (messages.length === 0) return s.thread.isLoading ? 'loading' : 'welcome';
    if (!s.thread.isRunning) return 'idle';
    const last = messages.at(-1);
    const writing =
      last?.role === 'assistant' &&
      last.content.some((part) => part.type === 'text' && part.text.trim().length > 0);
    return writing ? 'writing' : 'waiting';
  });

  const threadId = useAuiState((s) => s.threadListItem.id);
  const completed = useAuiState((s) => {
    const last = s.thread.messages.at(-1);
    return last?.role === 'assistant' && last.status?.type === 'complete';
  });
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  // The chat app shares its mascot element ref, so the atmosphere can measure the mascot.
  const ownRootRef = useRef<HTMLDivElement>(null);
  const rootRef = useContext(MascotElementContext) ?? ownRootRef;
  const eyesRef = useRef<SVGGElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const voiceActiveRef = useRef(callButton.active);
  voiceActiveRef.current = callButton.active;
  const recordingRef = useRef(recordingStatus);
  recordingRef.current = recordingStatus;
  const activity = error
    ? 'error'
    : recordingStatus === 'recording'
      ? 'listening'
      : recordingStatus === 'transcribing'
        ? 'thinking'
        : callButton.active
          ? agent.state
          : mode;
  const previous = useRef({ mode, threadId });
  useEffect(() => {
    const before = previous.current;
    previous.current = { mode, threadId };
    if (
      before.threadId !== threadId ||
      mode !== 'idle' ||
      !['waiting', 'writing'].includes(before.mode) ||
      !completed ||
      error ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const body = rootRef.current?.querySelector('.mascot-body');
    const animation = body?.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'translateY(-3px) scale(1.08, 0.94)', offset: 0.4 },
        { transform: 'scale(1)' },
      ],
      { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
    return () => animation?.cancel();
  }, [mode, threadId, completed, error, rootRef]);
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
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduceMotion = motionQuery.matches;
    const onMotionChange = () => {
      reduceMotion = motionQuery.matches;
      scheduleFrame();
    };
    motionQuery.addEventListener('change', onMotionChange);

    // Overlay coordinates persist across thread changes, even as content shrinks.
    let pos: Box | null = null;
    // Allow automatic scrolling to settle before gliding to a new anchor.
    let stableFrames = 0;
    let lastScrollTop = viewport.scrollTop;
    let lastThreadId = threadIdRef.current;
    const eye = { x: 0, y: 0 };
    const eyeVelocity = { x: 0, y: 0 };
    let gazeOffset = { x: 0, y: 0 };
    let nextSaccadeAt = 0;
    let nextMoodAt = 0;
    let moodIndex = 0;
    let previousFrameAt = 0;
    let mouse: { x: number; y: number } | null = null;
    let pointerActiveUntil = 0;
    let frame = 0;
    let lastActivityAt = performance.now();
    let sleepyTimer = 0;
    const setMoodForMode = () => {
      const currentMode = modeRef.current;
      root.dataset.mood =
        currentMode === 'writing' ? 'curious' : currentMode === 'waiting' ? 'attentive' : 'neutral';
    };
    const updateSleepiness = () => {
      const sleepy =
        document.visibilityState !== 'visible' ||
        !document.hasFocus() ||
        (performance.now() - lastActivityAt >= SLEEPY_AFTER &&
          !voiceActiveRef.current &&
          recordingRef.current === 'idle');
      if (sleepy) {
        root.dataset.mood = 'sleepy';
      } else if (root.dataset.mood === 'sleepy') {
        setMoodForMode();
      }
      return sleepy;
    };
    const scheduleSleepiness = () => {
      window.clearTimeout(sleepyTimer);
      const remaining = SLEEPY_AFTER - (performance.now() - lastActivityAt);
      if (remaining <= 0) {
        updateSleepiness();
      } else if (document.visibilityState === 'visible' && document.hasFocus()) {
        sleepyTimer = window.setTimeout(updateSleepiness, remaining);
      }
    };
    const onActivity = () => {
      lastActivityAt = performance.now();
      updateSleepiness();
      scheduleSleepiness();
    };
    const scheduleFrame = () => {
      if (!frame && document.visibilityState === 'visible') frame = requestAnimationFrame(tick);
    };
    const onPointerMove = (e: PointerEvent) => {
      mouse = { x: e.clientX, y: e.clientY };
      if (modeRef.current === 'welcome' && !reduceMotion) {
        const bounds = viewport.getBoundingClientRect();
        const x = Math.max(
          -1,
          Math.min(1, (e.clientX - bounds.left - bounds.width / 2) / (bounds.width / 2))
        );
        const y = Math.max(
          -1,
          Math.min(1, (e.clientY - bounds.top - bounds.height / 2) / (bounds.height / 2))
        );
        document.documentElement.style.setProperty(
          '--welcome-pointer-x',
          `${(x * 5).toFixed(2)}px`
        );
        document.documentElement.style.setProperty(
          '--welcome-pointer-y',
          `${(y * 4).toFixed(2)}px`
        );
      }
      pointerActiveUntil = performance.now() + 250;
      onActivity();
      scheduleFrame();
    };
    const resetParallax = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return;
      document.documentElement.style.setProperty('--welcome-pointer-x', '0px');
      document.documentElement.style.setProperty('--welcome-pointer-y', '0px');
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerout', resetParallax, { passive: true });
    const onScroll = () => {
      onActivity();
      scheduleFrame();
    };
    const onFocus = () => {
      onActivity();
      scheduleFrame();
    };
    const onBlur = () => {
      updateSleepiness();
      window.clearTimeout(sleepyTimer);
    };
    const onKeyDown = () => onActivity();
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        updateSleepiness();
        window.clearTimeout(sleepyTimer);
        cancelAnimationFrame(frame);
        frame = 0;
      } else {
        scheduleSleepiness();
        updateSleepiness();
        scheduleFrame();
      }
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    const resizeObserver = new ResizeObserver(scheduleFrame);
    resizeObserver.observe(viewport);
    resizeObserver.observe(container);
    const mutationObserver = new MutationObserver(scheduleFrame);
    mutationObserver.observe(viewport, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });

    let wrappedMessage: Element | null = null;
    const markWrapped = (message: Element | null) => {
      if (message === wrappedMessage) return;
      wrappedMessage?.removeAttribute('data-mascot-wrapped');
      message?.setAttribute('data-mascot-wrapped', '');
      wrappedMessage = message;
    };

    const tick = () => {
      frame = 0;
      const now = performance.now();
      const dt = Math.min((now - (previousFrameAt || now)) / 1000, 0.05);
      previousFrameAt = now;
      const settingsAnchor = document.querySelector<HTMLElement>('[data-mascot-anchor="settings"]');
      const voiceAnchor = voiceActiveRef.current
        ? document.querySelector<HTMLElement>('[data-mascot-anchor="voice"]')
        : null;
      container.style.zIndex = settingsAnchor ? '60' : '10';
      const switched = threadIdRef.current !== lastThreadId;
      const scrollDelta = viewport.scrollTop - lastScrollTop;
      stableFrames = !switched && scrollDelta === 0 ? stableFrames + 1 : 0;
      // Follow ordinary scrolling, but retain the rendered position on a switch.
      if (pos && !settingsAnchor && !voiceAnchor && !switched && scrollDelta !== 0) {
        pos = clampToViewport({ ...pos, y: pos.y - scrollDelta }, container, viewport);
      }
      lastScrollTop = viewport.scrollTop;
      lastThreadId = threadIdRef.current;

      let wrapped: Element | null = null;
      const specialBounds = (settingsAnchor ?? voiceAnchor)?.getBoundingClientRect();
      const spot = specialBounds
        ? {
            box: toBox(container, specialBounds.left, specialBounds.top, specialBounds.width),
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
      // The effective mode drives the CSS animation (considering while waiting).
      if (root.dataset.mode !== spot.mode) root.dataset.mode = spot.mode;
      root.classList.toggle('mascot-wrapped', spot.mode === 'idle' && wrappedMessage !== null);
      if (updateSleepiness()) {
        root.dataset.mood = 'sleepy';
      } else if (spot.mode === 'waiting') {
        root.dataset.mood = 'attentive';
      } else if (spot.mode === 'writing') {
        root.dataset.mood = 'curious';
      } else if (!reduceMotion && now >= nextMoodAt) {
        // Change expression slowly so it reads as a mood, not a slot machine.
        moodIndex = (moodIndex + 1 + Math.floor(Math.random() * (MOODS.length - 1))) % MOODS.length;
        root.dataset.mood = MOODS[moodIndex];
        nextMoodAt = now + 9000 + Math.random() * 7000;
      }
      const target = specialBounds ? spot.box : clampToViewport(spot.box, container, viewport);

      pos ??= { ...target };
      const ready = specialBounds !== undefined || stableFrames >= STABLE_FRAMES;
      if (ready) {
        // A plain ease-out glide (each frame covers a fixed share of the
        // remaining distance): it never overshoots, and snaps to whole pixels
        // at the end so there is no shimmer at rest.
        for (const key of ['x', 'y', 's'] as const) {
          pos[key] += (target[key] - pos[key]) * (reduceMotion ? 1 : 1 - Math.exp(-14 * dt));
          if (Math.abs(target[key] - pos[key]) < 0.3) pos[key] = target[key];
        }
      }
      const moving =
        Math.abs(target.x - pos.x) >= 0.3 ||
        Math.abs(target.y - pos.y) >= 0.3 ||
        Math.abs(target.s - pos.s) >= 0.3;

      root.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      root.style.width = `${pos.s}px`;
      root.style.height = `${pos.s}px`;

      // Small, irregular saccades keep the gaze from looking painted on.
      if (!reduceMotion && now >= nextSaccadeAt) {
        gazeOffset = {
          x: Math.random() * 2.4 - 1.2,
          y: Math.random() * 1.8 - 0.9,
        };
        nextSaccadeAt = now + 280 + Math.random() * 620;
      }

      // Eyes glance at new text while writing, centre while waiting, and
      // otherwise follow the pointer with a little involuntary movement.
      let ex = 0;
      let ey = 0;
      if (spot.mode === 'writing') {
        ex = -MAX_EYE_SHIFT;
        ey = 1;
      } else if (spot.mode !== 'waiting') {
        if (mouse) {
          const origin = container.getBoundingClientRect();
          const dx = mouse.x - (origin.left + pos.x + pos.s / 2);
          const dy = mouse.y - (origin.top + pos.y + pos.s / 2);
          const distance = Math.hypot(dx, dy) || 1;
          const reach = Math.min(1, distance / 240) * (MAX_EYE_SHIFT - 1);
          ex = (dx / distance) * reach;
          ey = (dy / distance) * reach;
        }
        ex += gazeOffset.x;
        ey += gazeOffset.y;
      }
      const gazeDistance = Math.hypot(ex, ey);
      if (gazeDistance > MAX_EYE_SHIFT) {
        ex = (ex / gazeDistance) * MAX_EYE_SHIFT;
        ey = (ey / gazeDistance) * MAX_EYE_SHIFT;
      }
      if (reduceMotion) {
        eye.x = ex;
        eye.y = ey;
        eyeVelocity.x = 0;
        eyeVelocity.y = 0;
      } else {
        // A damped spring makes quick gaze jumps settle with a tiny overshoot.
        const stiffness = 150;
        const damping = 0.82;
        const drag = 2 * Math.sqrt(stiffness) * damping;
        eyeVelocity.x += (stiffness * (ex - eye.x) - drag * eyeVelocity.x) * dt;
        eyeVelocity.y += (stiffness * (ey - eye.y) - drag * eyeVelocity.y) * dt;
        eye.x += eyeVelocity.x * dt;
        eye.y += eyeVelocity.y * dt;
      }
      eyesRef.current?.setAttribute(
        'transform',
        `translate(${eye.x.toFixed(2)} ${eye.y.toFixed(2)})`
      );
      const eyesSettling =
        !reduceMotion && (Math.abs(eyeVelocity.x) > 0.02 || Math.abs(eyeVelocity.y) > 0.02);
      if (moving || eyesSettling || (!reduceMotion && pointerActiveUntil > now)) scheduleFrame();
    };
    scheduleSleepiness();
    updateSleepiness();
    scheduleFrame();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerout', resetParallax);
      document.documentElement.style.removeProperty('--welcome-pointer-x');
      document.documentElement.style.removeProperty('--welcome-pointer-y');
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onKeyDown);
      viewport.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(sleepyTimer);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      motionQuery.removeEventListener('change', onMotionChange);
      markWrapped(null);
    };
  }, [viewportRef, rootRef]);

  const blinking = useRandomBlink(rootRef);

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
        data-activity={activity}
        className={cn(
          'artemis-mascot group/mascot absolute top-0 left-0 z-10 transition-opacity duration-200',
          easterEggEnabled ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none'
        )}
        style={{ width: 0, height: 0, opacity: 0 }}
      >
        <MascotMark className="mascot-body size-full">
          <g ref={eyesRef}>
            {showXMarks ? (
              <g fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round">
                <path d="m32 41 10 18m0-18L32 59m26-18 10 18m0-18L58 59" />
              </g>
            ) : (
              <g className={blinking ? 'mascot-blink' : undefined}>
                <g className="mascot-expression-eyes" fill="currentColor">
                  <rect x="29" y="32.5" width="16" height="35" rx="8" />
                  <rect x="55" y="32.5" width="16" height="35" rx="8" />
                </g>
              </g>
            )}
          </g>
        </MascotMark>
      </div>
    </div>,
    document.body
  );
}
