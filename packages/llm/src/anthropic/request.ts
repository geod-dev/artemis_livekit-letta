import type * as Messages from '@anthropic-ai/sdk/resources/messages';
import type { LlmMessage, LlmRequest, ToolDefinition, UserContent, AssistantContent } from '../types.ts';

/** Beta flag and context-management edit for server-side compaction. */
export const COMPACTION_BETA = 'compact-2026-01-12';

export interface AnthropicCallPlan {
  /** Plain Messages API params, or beta params when `beta` is true. */
  params: Messages.MessageCreateParamsBase & {
    betas?: string[];
    context_management?: { edits: Array<{ type: 'compact_20260112' }> };
  };
  beta: boolean;
}

type CacheControl = { type: 'ephemeral'; ttl?: '1h' };

/** Blocks that accept a `cache_control` breakpoint. */
const CACHEABLE = new Set(['text', 'image', 'tool_use', 'tool_result', 'compaction']);

/**
 * Translates a canonical request into Anthropic Messages params.
 * Never sends temperature, top_p or top_k.
 */
export function buildAnthropicCall(request: LlmRequest, cacheTtl: '5m' | '1h'): AnthropicCallPlan {
  const params: AnthropicCallPlan['params'] = {
    model: request.model,
    max_tokens: request.maxTokens,
    messages: request.messages.map(toMessage),
    thinking:
      request.thinking === 'disabled'
        ? { type: 'disabled' }
        : { type: 'adaptive', display: request.showReasoning ? 'summarized' : 'omitted' },
  };

  if (request.system) params.system = request.system;
  if (request.tools.length > 0) {
    params.tools = request.tools.map(toTool);
    if (request.parallelToolCalls === false) {
      params.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
    }
  }
  if (request.effort) params.output_config = { effort: request.effort };

  const beta = request.compaction === true;
  if (beta) {
    params.betas = [COMPACTION_BETA];
    params.context_management = { edits: [{ type: 'compact_20260112' }] };
  }
  if (request.cache) applyCacheBreakpoints(params, cacheTtl);

  return {
    params: request.providerOptions ? { ...params, ...request.providerOptions } : params,
    beta,
  };
}

/**
 * Breakpoints: last tool, system, last cacheable block of the last message
 * (three of Anthropic's four allowed). Changing any earlier byte invalidates them.
 */
function applyCacheBreakpoints(params: AnthropicCallPlan['params'], ttl: '5m' | '1h'): void {
  const control: CacheControl = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

  const tools = params.tools;
  const lastTool = tools?.[tools.length - 1];
  if (lastTool) lastTool.cache_control = control;

  if (typeof params.system === 'string' && params.system) {
    params.system = [{ type: 'text', text: params.system, cache_control: control }];
  }

  const lastMessage = params.messages[params.messages.length - 1];
  if (!lastMessage || typeof lastMessage.content === 'string') return;
  const blocks = lastMessage.content as Array<{ type: string; cache_control?: CacheControl }>;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block && CACHEABLE.has(block.type)) {
      block.cache_control = control;
      return;
    }
  }
}

function toTool(tool: ToolDefinition): Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Messages.Tool.InputSchema,
    eager_input_streaming: true,
  };
}

function toMessage(message: LlmMessage): Messages.MessageParam {
  if (message.role === 'user') {
    return { role: 'user', content: message.content.map(toUserBlock) };
  }
  return { role: 'assistant', content: message.content.flatMap(toAssistantBlocks) };
}

function toUserBlock(block: UserContent): Messages.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return imageParam(block.mediaType, block.data);
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content.map(part =>
          part.type === 'text' ? { type: 'text' as const, text: part.text } : imageParam(part.mediaType, part.data)
        ),
        is_error: block.isError,
      };
  }
}

/**
 * Replays assistant content verbatim. Reasoning without a signature or redacted
 * data cannot be replayed to Anthropic and is dropped; foreign provider blocks are dropped.
 */
function toAssistantBlocks(block: AssistantContent): Messages.ContentBlockParam[] {
  switch (block.type) {
    case 'text':
      return block.text ? [{ type: 'text', text: block.text }] : [];
    case 'reasoning':
      if (block.signature !== undefined) {
        return [{ type: 'thinking', thinking: block.text, signature: block.signature }];
      }
      if (block.redacted !== undefined) {
        return [{ type: 'redacted_thinking', data: block.redacted }];
      }
      return [];
    case 'tool_use':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input as Record<string, unknown> }];
    case 'provider':
      return block.provider === 'anthropic' ? [block.block as Messages.ContentBlockParam] : [];
  }
}

function imageParam(mediaType: string, data: string): Messages.ImageBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType as Messages.Base64ImageSource['media_type'], data },
  };
}
