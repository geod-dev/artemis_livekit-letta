import { memo, useCallback, useRef } from 'react';
import { type ReasoningMessagePartComponent, useScrollLock } from '@assistant-ui/react';
import {
  ANIMATION_DURATION,
  ReasoningContent,
  ReasoningFade,
  ReasoningRoot as ReasoningRootBase,
  type ReasoningRootProps,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/chat-primitives/chat/reasoning-disclosure';
import { MarkdownText } from '@/components/media/markdown/markdown-text';

export type { ReasoningRootProps } from '@/components/chat-primitives/chat/reasoning-disclosure';

/** `ReasoningRoot` with the thread viewport scroll locked during disclosure animations. */
function ReasoningRoot({ ref, onAnimationStart, ...props }: ReasoningRootProps) {
  const collapsibleRef = useRef<HTMLDivElement | null>(null);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const handleAnimationStart = useCallback(() => {
    lockScroll();
    onAnimationStart?.();
  }, [lockScroll, onAnimationStart]);

  const composedRef = useCallback(
    (node: HTMLDivElement | null) => {
      collapsibleRef.current = node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        (ref as { current: HTMLDivElement | null }).current = node;
      }
    },
    [ref]
  );

  return <ReasoningRootBase ref={composedRef} onAnimationStart={handleAnimationStart} {...props} />;
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;

const Reasoning = memo(ReasoningImpl) as unknown as ReasoningMessagePartComponent & {
  Root: typeof ReasoningRoot;
  Trigger: typeof ReasoningTrigger;
  Content: typeof ReasoningContent;
  Text: typeof ReasoningText;
  Fade: typeof ReasoningFade;
};

Reasoning.displayName = 'Reasoning';
Reasoning.Root = ReasoningRoot;
Reasoning.Trigger = ReasoningTrigger;
Reasoning.Content = ReasoningContent;
Reasoning.Text = ReasoningText;
Reasoning.Fade = ReasoningFade;

export {
  Reasoning,
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
  ReasoningFade,
};
