import type { ReasoningEffort } from '@letta-ai/letta-agent-sdk';

const SDK_EFFORTS = new Set<string>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const GLM_EFFORTS: Record<string, ReasoningEffort> = {
  low: 'low',
  medium: 'high',
  high: 'xhigh',
};

export interface ModelEffortAdapterResult {
  reasoningEffort?: ReasoningEffort;
  /** The unrecognized configured value is kept as diagnostics, never sent to the SDK. */
  invalidConfiguredEffort?: string;
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return SDK_EFFORTS.has(value);
}

/** Map configured/user effort values to the SDK's supported reasoning tiers. */
export function modelEffort(handle: string, effort: string): ModelEffortAdapterResult {
  if (!effort) return {};
  let candidate = effort;
  if (/(?:^|\/)glm-5\.3(?:-flash)?$/i.test(handle)) {
    candidate = GLM_EFFORTS[effort] ?? effort;
  }
  if (isReasoningEffort(candidate)) return { reasoningEffort: candidate };
  return { invalidConfiguredEffort: effort };
}
