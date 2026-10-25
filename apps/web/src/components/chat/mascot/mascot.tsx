import { type RefObject, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuiState } from '@assistant-ui/react';
import { useAgent } from '@livekit/components-react';
import { MascotElementContext } from '@/components/chat/context';
import { type Mode } from '@/components/chat/mascot/constants';
import { MascotMark } from '@/components/chat/mascot/mascot-mark';
import { useChatThread } from '@/hooks/use-chat-thread';
import { useMascotMotion } from '@/hooks/use-mascot-motion';
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

  useMascotMotion({
    rootRef,
    eyesRef,
    viewportRef,
    modeRef,
    threadIdRef,
    voiceActiveRef,
    recordingRef,
  });

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
