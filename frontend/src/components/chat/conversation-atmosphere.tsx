import { type RefObject, useEffect, useRef, useSyncExternalStore } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { useAgent, useTrackVolume } from '@livekit/components-react';
import { useChatThread } from '@/components/chat/thread-slots';
import { turnAtmosphere } from '@/lib/conversation-atmosphere';

const DESKTOP = '(min-width: 1024px) and (hover: hover) and (pointer: fine)';
const REDUCED = '(prefers-reduced-motion: reduce)';
const AUDIO_OPTIONS = { fftSize: 64, smoothingTimeConstant: 0.85 };

function environmentSnapshot() {
  if (
    !window.matchMedia(DESKTOP).matches ||
    !document.documentElement.classList.contains('dark') ||
    document.visibilityState !== 'visible'
  )
    return 0;
  return window.matchMedia(REDUCED).matches ? 3 : 1;
}

function subscribeEnvironment(update: () => void) {
  const desktop = window.matchMedia(DESKTOP);
  const reduced = window.matchMedia(REDUCED);
  desktop.addEventListener('change', update);
  reduced.addEventListener('change', update);
  document.addEventListener('visibilitychange', update);
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => {
    desktop.removeEventListener('change', update);
    reduced.removeEventListener('change', update);
    document.removeEventListener('visibilitychange', update);
    observer.disconnect();
  };
}

/** Two cached soft light sources. No canvas, changing gradient, or idle frame loop. */
export function ConversationAtmosphere({
  viewportRef,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const environment = useSyncExternalStore(subscribeEnvironment, environmentSnapshot, () => 0);
  const agent = useAgent();
  const { callButton, error, tasks } = useChatThread();
  const turn = useAuiState((s) => {
    const last = s.thread.messages.at(-1);
    return turnAtmosphere(s.thread.isRunning, last?.role === 'assistant' ? last.content : []);
  });
  const state = error
    ? 'idle'
    : callButton.active && agent.state === 'speaking'
      ? 'speaking'
      : turn === 'tools' || tasks.length > 0
        ? 'tools'
        : callButton.active && agent.state === 'thinking'
          ? 'thinking'
          : turn;
  const lightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const light = lightRef.current;
    const viewport = viewportRef.current;
    if (!environment || !light || !viewport || state === 'idle') return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const mascot = document.querySelector<HTMLElement>('.artemis-mascot');
      const mark = mascot?.getBoundingClientRect();
      const bounds = light.getBoundingClientRect();
      if (!mark || !bounds.width || !bounds.height || mascot?.style.opacity === '0') return;
      const x = Math.max(
        12,
        Math.min(88, ((mark.left + mark.width / 2 - bounds.left) / bounds.width) * 100)
      );
      const y = Math.max(
        15,
        Math.min(80, ((mark.top + mark.height / 2 - bounds.top) / bounds.height) * 100)
      );
      light.style.setProperty('--light-x', `${x.toFixed(1)}%`);
      light.style.setProperty('--light-y', `${y.toFixed(1)}%`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // Let the character settle into its reply anchor; do not chase every frame.
    const timer = window.setTimeout(schedule, 240);
    viewport.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [environment, state, viewportRef]);

  if (!environment) return null;
  return (
    <div ref={lightRef} className="conversation-atmosphere" data-state={state} aria-hidden="true">
      <div className="conversation-light conversation-light-cyan" />
      <div className="conversation-light conversation-light-violet" />
      {state === 'speaking' && environment === 1 && agent.microphoneTrack && (
        <SpeakingLight targetRef={lightRef} track={agent.microphoneTrack} />
      )}
    </div>
  );
}

/** Only mounted for audible speech on a visible desktop; samples the agent, not the user. */
function SpeakingLight({
  targetRef,
  track,
}: {
  targetRef: RefObject<HTMLDivElement | null>;
  track: NonNullable<ReturnType<typeof useAgent>['microphoneTrack']>;
}) {
  const volume = useTrackVolume(track, AUDIO_OPTIONS);
  useEffect(() => {
    const level = volume < 0.025 ? 0 : Math.min(1, Math.sqrt(volume) * 1.8);
    targetRef.current?.style.setProperty('--speech-light', level.toFixed(3));
  }, [volume, targetRef]);
  useEffect(() => {
    const target = targetRef.current;
    return () => {
      target?.style.removeProperty('--speech-light');
    };
  }, [targetRef]);
  return null;
}
