import {
  type ComponentType,
  type FC,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import { ArrowUpIcon, AudioLinesIcon, PhoneOffIcon, SquareIcon } from 'lucide-react';
import { type AssistantState, AuiIf, ComposerPrimitive, useAuiState } from '@assistant-ui/react';
import {
  ComposerAddAttachment,
  ComposerAttachments,
} from '@/components/assistant-ui/composer/attachment';
import { ComposerContext } from '@/components/assistant-ui/composer/context';
import { ComposerVoice, ComposerVoiceButton } from '@/components/assistant-ui/composer/voice';
import { IconButton } from '@/components/assistant-ui/shared/icon-button';
import type { ChatThreadState } from '@/components/chat/thread-slots';
import { MascotRecordingContext, useChatThread } from '@/components/chat/thread-slots';
import { Button } from '@/components/ui/button';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';

type ThreadComposerProps = {
  autoFocus: boolean;
  placeholder: string;
  docked: boolean;
  ComposerEffort?: ComponentType | undefined;
  callButton: ChatThreadState['callButton'];
};

// The composer moves between the welcome centre and the conversation footer.
// Keep its last position across thread remounts so the transition stays smooth.
let lastComposerTop: number | null = null;

const useComposerGlide = (docked: boolean) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const from = lastComposerTop;
    lastComposerTop = top;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (from === null || reduceMotion || Math.abs(from - top) < 8) return;
    element.animate([{ transform: `translateY(${from - top}px)` }, { transform: 'none' }], {
      duration: 420,
      easing: 'cubic-bezier(0.25, 1.06, 0.4, 1)',
    });
  }, [docked]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const remember = () => {
      if (element.getAnimations().length === 0) {
        lastComposerTop = element.getBoundingClientRect().top;
      }
    };
    const observer = new ResizeObserver(remember);
    observer.observe(element);
    window.addEventListener('resize', remember);
    document.addEventListener('scroll', remember, { capture: true, passive: true });
    return () => {
      remember();
      observer.disconnect();
      window.removeEventListener('resize', remember);
      document.removeEventListener('scroll', remember, true);
    };
  }, []);
  return ref;
};

export const ThreadComposer: FC<ThreadComposerProps> = ({
  autoFocus,
  placeholder,
  docked,
  ComposerEffort,
  callButton,
}) => {
  const glideRef = useComposerGlide(docked);
  return (
    <div ref={glideRef} className="aui-thread-composer w-full">
      <ComposerRoot autoFocus={autoFocus} placeholder={placeholder}>
        <ComposerAction ComposerEffort={ComposerEffort} callButton={callButton} />
      </ComposerRoot>
    </div>
  );
};

const ComposerRoot: FC<{
  autoFocus: boolean;
  placeholder: string;
  children: ReactNode;
}> = ({ autoFocus, placeholder, children }) => (
  <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
    <ComposerPrimitive.AttachmentDropzone asChild>
      <div
        data-slot="aui_composer-shell"
        className="aui-composer-shell surface-panel data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-2 rounded-(--surface-radius) p-(--surface-inset) transition-[border-color] duration-200 data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
      >
        <ComposerAttachments />
        <ComposerPrimitive.Input
          placeholder={placeholder}
          className="aui-composer-input caret-primary placeholder:text-muted-foreground/70 relative z-20 max-h-48 min-h-10 w-full resize-none bg-transparent px-3 py-1.5 text-base leading-6 outline-none"
          rows={1}
          autoFocus={autoFocus}
          enterKeyHint="send"
          spellCheck
          aria-label="Message input"
        />
        {children}
      </div>
    </ComposerPrimitive.AttachmentDropzone>
  </ComposerPrimitive.Root>
);

const ComposerAction: FC<{
  ComposerEffort?: ComponentType | undefined;
  callButton: ChatThreadState['callButton'];
}> = ({ ComposerEffort, callButton }) => {
  const { contextUsage } = useChatThread();
  const isSending = useAuiState(
    (s) =>
      s.composer.submission !== undefined && !(s.thread.isRunning && s.thread.capabilities.cancel)
  );
  const recorder = useVoiceRecorder();
  const setMascotRecording = useContext(MascotRecordingContext);
  useEffect(() => {
    setMascotRecording(recorder.status);
    return () => setMascotRecording('idle');
  }, [recorder.status, setMascotRecording]);
  const composerEmpty = useAuiState((s: AssistantState) => s.composer.isEmpty);
  const hasComposerAttachments = useAuiState(
    (s: AssistantState) => s.composer.attachments.length > 0
  );
  const canCancel = useAuiState((s: AssistantState) => s.composer.canCancel);
  const showCallButton = composerEmpty && !hasComposerAttachments && !canCancel;

  if (recorder.status !== 'idle') return <ComposerVoice recorder={recorder} />;

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.attachments}>
          <ComposerAddAttachment />
        </AuiIf>
      </div>
      <div className="ms-auto flex items-center gap-2">
        <AuiIf condition={(s) => s.thread.messages.length > 0}>
          {contextUsage && (
            <ComposerContext
              usage={{
                used: contextUsage.usedTokens / 1_000,
                total: contextUsage.windowTokens / 1_000,
              }}
            />
          )}
        </AuiIf>
        {ComposerEffort && <ComposerEffort />}
        <ComposerVoiceButton recorder={recorder} />
        {showCallButton ? (
          <IconButton
            label={callButton.label}
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-call ms-1 size-8 rounded-full"
            aria-label={callButton.label}
            disabled={callButton.disabled || hasComposerAttachments}
            onClick={callButton.onClick}
          >
            {callButton.active ? (
              <PhoneOffIcon className="size-4" />
            ) : (
              <AudioLinesIcon className="size-4" />
            )}
          </IconButton>
        ) : (
          <AuiIf
            condition={(s) =>
              !s.composer.canCancel ||
              (s.thread.voice !== undefined && s.composer.submission === undefined)
            }
          >
            <ComposerPrimitive.Send asChild>
              <IconButton
                label="Send message"
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-send ms-1 size-9 rounded-full"
                aria-label="Send message"
              >
                <ArrowUpIcon className="aui-composer-send-icon size-4" />
              </IconButton>
            </ComposerPrimitive.Send>
          </AuiIf>
        )}
        <AuiIf
          condition={(s) =>
            s.composer.canCancel &&
            (s.thread.voice === undefined || s.composer.submission !== undefined)
          }
        >
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-8 rounded-full"
              aria-label={isSending ? 'Cancel sending' : 'Stop generating'}
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};
