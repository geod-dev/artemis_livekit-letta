import type { AnyAgentTool } from '@letta-ai/letta-agent-sdk';
import type { CallMode, Modality } from '../chat-types';
import { callControls } from './calls';
import { PRESENT_TOOL, presentDescription, presentOutcome, presentParameters } from './present';

/**
 * Client tools: executed in this process, registered on every Letta session of
 * a conversation. Background work uses Letta's native `Agent` tool instead.
 */
export function createTools(conversationId: string): AnyAgentTool[] {
  return [
    {
      name: 'set_call_mode',
      label: 'Set call mode',
      description:
        'Sets the mode of the active voice call, effective when the current response has finished playing. "short": the call ends after a response marked [done] has finished playing. "long": the call stays open until end_call is called or the user hangs up. Fails when no voice call is active.',
      parameters: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['short', 'long'] } },
        required: ['mode'],
      },
      async execute(_toolCallId, input) {
        const { mode } = input as { mode: CallMode };
        return outcome(callControls.setMode(conversationId, mode), `Call mode: ${mode}.`);
      },
    },
    {
      name: 'end_call',
      label: 'End call',
      description:
        'Ends the voice call once the current response has finished playing, in either call mode. Fails when no voice call is active.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return outcome(callControls.end(conversationId), 'The call ends after this response.');
      },
    },
    {
      // Generative UI: the chat renders the call's arguments.
      name: PRESENT_TOOL,
      label: 'Present UI',
      description: presentDescription,
      parameters: presentParameters,
      async execute(_toolCallId, input) {
        const { text, isError } = presentOutcome(input);
        return { content: [{ type: 'text' as const, text }], isError };
      },
    },
  ];
}

/**
 * The tools a turn of this modality is offered: `present` draws in the chat, so
 * voice turns go without it (and without its large schema in the prompt).
 */
export function toolsFor(tools: AnyAgentTool[], modality: Modality): AnyAgentTool[] {
  return modality === 'voice' ? tools.filter((tool) => tool.name !== PRESENT_TOOL) : tools;
}

function outcome(applied: boolean, done: string) {
  const message = applied ? done : 'No voice call is active in this conversation.';
  return { content: [{ type: 'text' as const, text: message }], isError: !applied };
}
