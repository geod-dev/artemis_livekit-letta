import type * as Chat from 'openai/resources/chat/completions';
import type { JsonSchema, LlmMessage, LlmRequest, ToolDefinition, UserContent } from '../types.ts';

export type ChatMessageParam = Chat.ChatCompletionMessageParam;

/**
 * Translates a canonical request into Chat Completions params (streaming).
 * `max_tokens` (not `max_completion_tokens`) and the `system` role match Telnyx;
 * `store` is never sent.
 */
export function buildChatRequest(request: LlmRequest): Chat.ChatCompletionCreateParamsStreaming {
  const messages: ChatMessageParam[] = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  for (const message of request.messages) messages.push(...toChatMessages(message));

  const params: Chat.ChatCompletionCreateParamsStreaming = {
    model: request.model,
    messages,
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.tools.length > 0) {
    params.tools = request.tools.map(toTool);
    if (request.parallelToolCalls !== undefined) params.parallel_tool_calls = request.parallelToolCalls;
  }
  if (request.effort) params.reasoning_effort = request.effort;

  return request.providerOptions ? { ...params, ...request.providerOptions } : params;
}

function toTool(tool: ToolDefinition): Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as JsonSchema,
    },
  };
}

function toChatMessages(message: LlmMessage): ChatMessageParam[] {
  return message.role === 'user' ? toUserMessages(message.content) : toAssistantMessages(message.content);
}

/**
 * Tool results become `tool` messages, which must directly follow the assistant
 * tool calls; any other user content (and images from tool results, which `tool`
 * messages cannot carry) goes into one trailing user message.
 */
function toUserMessages(content: UserContent[]): ChatMessageParam[] {
  const toolMessages: ChatMessageParam[] = [];
  const parts: Chat.ChatCompletionContentPart[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text });
        break;
      case 'image':
        parts.push(imagePart(block.mediaType, block.data));
        break;
      case 'tool_result': {
        toolMessages.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          content: toolResultText(block.content, block.isError),
        });
        for (const part of block.content) {
          if (part.type === 'image') parts.push(imagePart(part.mediaType, part.data));
        }
        break;
      }
    }
  }
  if (parts.length > 0) toolMessages.push({ role: 'user', content: userContent(parts) });
  return toolMessages;
}

function toAssistantMessages(content: Extract<LlmMessage, { role: 'assistant' }>['content']): ChatMessageParam[] {
  // Reasoning is not replayed to this provider; foreign provider blocks are dropped.
  const text = content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
  const toolCalls: Chat.ChatCompletionMessageToolCall[] = content.flatMap(block =>
    block.type === 'tool_use'
      ? [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }]
      : []
  );
  if (!text && toolCalls.length === 0) return [];
  return [
    {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ];
}

function toolResultText(content: Array<{ type: 'text'; text: string } | { type: 'image' }>, isError: boolean): string {
  const text = content
    .flatMap(part => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  const hasImage = content.some(part => part.type === 'image');
  const body = text || (hasImage ? '(image output follows)' : '(no output)');
  return isError ? `Error: ${body}` : body;
}

function userContent(parts: Chat.ChatCompletionContentPart[]): string | Chat.ChatCompletionContentPart[] {
  const [only] = parts;
  if (parts.length === 1 && only?.type === 'text') return only.text;
  return parts;
}

function imagePart(mediaType: string, data: string): Chat.ChatCompletionContentPartImage {
  return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } };
}
