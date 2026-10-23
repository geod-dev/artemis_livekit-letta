import { createContext } from 'react';
import type { AgentRun } from '@/lib/agent-runs';

/** The background runs a thread's tool calls show, and how to open one. */
export const ToolActivityContext = createContext<{
  tasks: AgentRun[];
  openTask: (task: AgentRun) => void;
} | null>(null);
