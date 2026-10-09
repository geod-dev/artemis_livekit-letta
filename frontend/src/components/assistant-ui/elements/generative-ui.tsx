import { useMemo } from 'react';
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
  presentTree,
  replyMessage,
} from '@/lib/generative-ui';
import { MarkdownDocument } from './markdown-text';
import { ToolFallback } from './tool-fallback.aui';

/** The `present` vocabulary, with markdown rendered like message text (workspace files as cards). */
const library = presentLibrary(({ value, children }) => (
  <div data-aui="markdown">
    {value ? <MarkdownDocument text={value} /> : null}
    {children}
  </div>
));

/**
 * A `present` call: the component tree the assistant composed, once the call
 * has completed (Letta runs the tool; its arguments reach the chat with the
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
  const tree = useMemo(() => presentTree(part.args), [part.args]);

  if (part.status.type !== 'complete' || part.isError) return <ToolFallback {...part} />;
  return (
    <div data-aui="root" className="my-3 text-sm">
      {renderGenerativeUI(tree, library, { status: 'done', dispatch })}
    </div>
  );
};

/**
 * Render-only toolkit for the tools Letta runs: `present` draws its UI on its
 * own, outside the collapsed tool groups.
 */
export const generativeUIToolkit = defineToolkit({
  [PRESENT_TOOL]: { type: 'backend', display: 'standalone', render: PresentToolUI },
});
