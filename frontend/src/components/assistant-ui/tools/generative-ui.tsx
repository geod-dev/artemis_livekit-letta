import { Component, type ErrorInfo, type ReactNode, useMemo } from 'react';
import { type ToolCallMessagePartComponent, defineToolkit, useAui } from '@assistant-ui/react';
import {
  type GenerativeUIDispatch,
  createActionRegistry,
  renderGenerativeUI,
} from '@assistant-ui/react-generative-ui';
import {
  PRESENT_TOOL,
  REPLY_ACTION,
  presentLibrary,
  replyMessage,
  validatePresent,
} from '@/lib/generative-ui';
import { MarkdownDocument } from '@/components/assistant-ui/markdown/markdown-text';
import { ToolFallback } from '@/components/assistant-ui/tools/tool-fallback';

/** The `present` vocabulary, with markdown rendered like message text (workspace files as cards). */
const library = presentLibrary(({ value, children }) => (
  <div data-aui="markdown">
    {value ? <MarkdownDocument text={value} /> : null}
    {children}
  </div>
));

/** Keep a malformed or unexpectedly failing UI local to its own message. */
class GenerativeUIErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Rendering failures can include model supplied content; do not log it.
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          className="border-border text-muted-foreground my-3 rounded-md border p-3 text-sm"
        >
          This interactive response could not be displayed.
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * A `present` call: the component tree the assistant composed, once the call
 * has completed (the agent-server runs the tool; its arguments reach the chat with the
 * result). While it runs, and when it failed, it shows as a tool call.
 * Controls answer through the `reply` action, which sends a user message.
 */
const PresentToolUI: ToolCallMessagePartComponent = (part) => {
  const aui = useAui();
  const dispatch = useMemo<GenerativeUIDispatch>(() => {
    const actions = createActionRegistry({
      [REPLY_ACTION]: ({ payload }) => {
        const text = replyMessage(payload);
        if (text) void aui.thread().append({ role: 'user', content: [{ type: 'text', text }] });
      },
    });
    return (action) => actions.dispatch(action);
  }, [aui]);
  const validation = useMemo(() => validatePresent(part.args), [part.args]);

  if (part.status.type !== 'complete' || part.isError) return <ToolFallback {...part} />;
  if (!validation.ok) {
    return (
      <div
        role="alert"
        className="border-border text-muted-foreground my-3 rounded-md border p-3 text-sm"
      >
        This response contains an invalid interface and could not be displayed.
      </div>
    );
  }
  return (
    <div data-aui="root" className="aui-generative-root my-3 text-sm">
      <GenerativeUIErrorBoundary>
        {renderGenerativeUI(validation.tree, library, { status: 'done', dispatch })}
      </GenerativeUIErrorBoundary>
    </div>
  );
};

/**
 * Render-only toolkit for the tools the agent runs: `present` draws its UI on its
 * own, outside the collapsed tool groups.
 */
export const generativeUIToolkit = defineToolkit({
  [PRESENT_TOOL]: { type: 'backend', display: 'standalone', render: PresentToolUI },
});
