import type { Modality, TextEffort } from '../../chat-types';

/** Claude effort remains independent of whether thinking is enabled. */
export function assistantModelSettings(modality: Modality, effort: TextEffort = 'medium') {
  return {
    provider_type: 'anthropic' as const,
    effort: modality === 'voice' ? 'medium' as const : effort,
    thinking: { type: modality === 'voice' ? 'disabled' as const : 'enabled' as const },
    parallel_tool_calls: true,
  };
}
