import type { RecallBudget } from './store.ts';

/**
 * Recall budget for the answer about to be generated (fixed product rule):
 * voice -> `low`; text at effort low/medium -> `mid`; text at high/xhigh/max -> `high`.
 * A text turn without an explicit effort runs at `medium`.
 */
export function recallBudget(input: {
  modality: 'text' | 'voice';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
}): RecallBudget {
  if (input.modality === 'voice') return 'low';
  switch (input.effort ?? 'medium') {
    case 'low':
    case 'medium':
      return 'mid';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
  }
}
