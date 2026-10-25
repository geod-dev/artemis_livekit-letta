import { memo, useState } from 'react';
import { TOOL_NAMES } from '@artemis/contracts/tool-names';
import { type ToolCallMessagePartComponent } from '@assistant-ui/react';
import { BashTerminal } from '@/components/chat-primitives/tools/bash-terminal';
import { ToolAgentCall } from '@/components/chat-primitives/tools/tool-agent-call';
import { toolCallUi } from '@/components/chat-primitives/tools/tool-display';
import {
  ToolFallbackArgs,
  ToolFallbackContent,
  ToolFallbackError,
  ToolFallbackResult,
  ToolFallbackRoot,
  ToolFallbackTrigger,
} from '@/components/chat-primitives/tools/tool-fallback-parts';
import { WebSearchResults } from '@/components/chat-primitives/tools/web-search-results';
import { cn } from '@/lib/shadcn/utils';
import { toolCall } from '@/lib/tool-display';
import { selectToolRenderer, toolResultFormat } from '@/lib/tool-renderer';

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolCallId,
  toolName,
  argsText,
  artifact,
  result,
  status,
}) => {
  const isCancelled = status?.type === 'incomplete' && status.reason === 'cancelled';
  const ui = toolCallUi(artifact);
  const call = toolCall(toolName, argsText, ui);
  const isRunning = status?.type === 'running';
  const renderer = selectToolRenderer(call, result, isRunning);
  const showCards = renderer.kind === 'generic';
  const [open, setOpen] = useState(false);
  if (toolName === TOOL_NAMES.runAgent) {
    return <ToolAgentCall toolCallId={toolCallId} call={call} />;
  }

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger
        toolCallId={toolCallId}
        toolName={toolName}
        argsText={argsText}
        ui={ui}
        status={status}
      />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        {renderer.kind === 'web-search' ? (
          <WebSearchResults query={renderer.query} output={renderer.output} />
        ) : renderer.kind === 'terminal' ? (
          <BashTerminal command={renderer.command} output={renderer.output} />
        ) : (
          <ToolFallbackArgs
            toolName={toolName}
            argsText={argsText}
            ui={ui}
            className={cn(isCancelled && 'opacity-60')}
          />
        )}
        {showCards && (
          <ToolFallbackResult
            result={result}
            display={ui.display}
            format={toolResultFormat(call)}
          />
        )}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(ToolFallbackImpl) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
};

ToolFallback.displayName = 'ToolFallback';
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;

export { ToolFallback };
