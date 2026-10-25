import { useContext } from 'react';
import { toolCallLabel } from '@/components/chat-primitives/tools/tool-display';
import { ToolRunActivityContext } from '@/components/chat/context';
import type { ToolCall } from '@/lib/tool-display';

/**
 * A worker call (`run_agent`): its label, which opens the agent's run when the
 * thread knows it. The label reads "<agent> - <what happened>", split at the dash.
 */
export function ToolAgentCall({ toolCallId, call }: { toolCallId: string; call: ToolCall }) {
  const activity = useContext(ToolRunActivityContext);
  const run = activity?.tasks.find((task) => task.toolCallId === toolCallId);
  const args = call.args;
  const target = run ?? {
    id: 'launch:' + toolCallId,
    agentTitle: undefined,
    toolCallId,
    title: typeof args.description === 'string' ? args.description : 'Agent',
    prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
    kind: 'agent' as const,
    status: 'running' as const,
  };
  const label = toolCallLabel(call, target.agentTitle);
  const separator = label.indexOf(' - ');
  return (
    <div className="flex w-full items-start text-sm">
      <button
        type="button"
        disabled={!activity}
        onClick={() => activity?.openTask(target)}
        className="group/agent-call text-muted-foreground hover:text-foreground focus-visible:outline-ring flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-1 text-left text-xs transition-colors focus-visible:outline-2"
      >
        {separator < 0 ? (
          label
        ) : (
          <>
            <span className="text-foreground/75 group-hover/agent-call:text-foreground group-focus-visible/agent-call:text-foreground transition-colors">
              {label.slice(0, separator)}
            </span>
            <span className="text-muted-foreground/60">
              {' - '}
              {label.slice(separator + 3)}
            </span>
          </>
        )}
      </button>
    </div>
  );
}
