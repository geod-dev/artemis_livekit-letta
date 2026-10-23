import { type FC, useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, MicIcon, SquareIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useAui } from '@assistant-ui/react';
import { IconButton } from '@/components/assistant-ui/shared/icon-button';
import type { VoiceRecorder } from '@/hooks/use-voice-recorder';
import { cn } from '@/lib/shadcn/utils';

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const SAMPLE_MS = 50;
const MAX_LEVELS = 512;

/**
 * A scrolling level meter of the microphone: one bar per sample, newest on
 * the right. Without an analyser it holds the last frame (while transcribing).
 */
const VoiceWaveform: FC<{ analyser: AnalyserNode | null; className?: string }> = ({
  analyser,
  className,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levels = useRef<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const samples = analyser ? new Uint8Array(analyser.fftSize) : null;
    let frame = 0;
    let lastSample = 0;
    let width = 0;
    let height = 0;
    let dpr = window.devicePixelRatio || 1;
    let color = getComputedStyle(canvas).color;
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();
    const themeObserver = new MutationObserver(() => {
      color = getComputedStyle(canvas).color;
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const draw = (now: number) => {
      if (analyser && samples && now - lastSample >= SAMPLE_MS) {
        lastSample = now;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += ((value - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / samples.length);
        levels.current.push(Math.min(1, Math.max(0, Math.sqrt(rms) * 2.2 - 0.08)));
        if (levels.current.length > MAX_LEVELS) levels.current.shift();
      }

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;

      const count = Math.max(0, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));
      const offset = width - count * (BAR_WIDTH + BAR_GAP) + BAR_GAP;
      const recent = levels.current.slice(-count);
      for (let i = 0; i < count; i++) {
        const level = recent[i - (count - recent.length)] ?? 0;
        const barHeight = Math.max(BAR_WIDTH, level * height);
        ctx.beginPath();
        ctx.roundRect(
          offset + i * (BAR_WIDTH + BAR_GAP),
          (height - barHeight) / 2,
          BAR_WIDTH,
          barHeight,
          BAR_WIDTH / 2
        );
        ctx.fill();
      }

      if (analyser) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, [analyser]);

  return <canvas ref={canvasRef} aria-hidden className={cn('block', className)} />;
};

const ElapsedTime: FC<{ since: number | null; className?: string }> = ({ since, className }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const seconds = since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className={className}>
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
};

const errorMessage = (error: unknown) =>
  error instanceof DOMException && error.name === 'NotAllowedError'
    ? 'Microphone access was denied'
    : error instanceof Error
      ? error.message
      : String(error);

/** Starts a voice recording; shown while the composer is idle. */
export const ComposerVoiceButton: FC<{ recorder: VoiceRecorder }> = ({ recorder }) => (
  <IconButton
    label="Voice input"
    type="button"
    variant="ghost"
    size="icon"
    className="aui-composer-voice text-muted-foreground hover:text-foreground size-8 rounded-full"
    aria-label="Start voice input"
    onClick={() =>
      void recorder.start().catch((error) => {
        toast.error(errorMessage(error));
      })
    }
  >
    <MicIcon className="size-4" />
  </IconButton>
);

/**
 * The composer's action row while recording: cancel on the left, the live
 * waveform in the middle, then "stop" (transcribe into the input) and "send"
 * (transcribe and send) on the right.
 */
export const ComposerVoice: FC<{ recorder: VoiceRecorder }> = ({ recorder }) => {
  const aui = useAui();
  const transcribing = recorder.status === 'transcribing';

  const finish = async (send: boolean) => {
    let text: string | null;
    try {
      text = await recorder.stop();
    } catch (error) {
      toast.error(errorMessage(error));
      return;
    }
    if (text === null) return;
    if (!text) {
      toast('No speech detected');
      return;
    }
    const current = aui.composer.getState().text;
    aui.composer.setText(current.trim() ? `${current.trimEnd()} ${text}` : text);
    if (!send) return;
    // Same rule as the send button: while a turn runs, send only if the thread queues.
    const thread = aui.thread.getState();
    if (thread.isRunning && !thread.capabilities.queue && thread.voice === undefined) return;
    // Not gated on `getState().canSend`: on external-store threads that state is
    // the last render's, still empty right after `setText`. `send()` reads the
    // live text and applies the same empty/disabled/in-flight checks itself.
    aui.composer.send();
  };

  return (
    <div className="aui-composer-voice-root flex items-center gap-1.5">
      <IconButton
        label="Cancel recording"
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground size-8 rounded-full"
        aria-label="Cancel recording"
        onClick={recorder.cancel}
      >
        <XIcon className="size-4" />
      </IconButton>
      <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
        {!transcribing && (
          <span className="bg-destructive size-2 shrink-0 animate-pulse rounded-full" />
        )}
        <VoiceWaveform
          analyser={recorder.analyser}
          className={cn(
            'h-7 min-w-0 flex-1 transition-colors',
            transcribing ? 'text-muted-foreground/40' : 'text-foreground/75'
          )}
        />
        {transcribing ? (
          <span className="shimmer text-muted-foreground shrink-0 text-xs motion-reduce:animate-none">
            Transcribing
          </span>
        ) : (
          <ElapsedTime
            since={recorder.startedAt}
            className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums"
          />
        )}
      </div>
      <IconButton
        label="Stop and edit"
        type="button"
        variant="ghost"
        size="icon"
        className="text-foreground size-8 rounded-full"
        aria-label="Stop recording and edit"
        disabled={transcribing}
        onClick={() => void finish(false)}
      >
        <SquareIcon className="size-3.5 fill-current" />
      </IconButton>
      <IconButton
        label="Send"
        type="button"
        variant="default"
        size="icon"
        className="bouncy size-8 rounded-full"
        aria-label="Stop recording and send"
        disabled={transcribing}
        onClick={() => void finish(true)}
      >
        <ArrowUpIcon className="size-4" />
      </IconButton>
    </div>
  );
};
