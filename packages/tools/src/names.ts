/**
 * Every tool name the agents can see, in the order they are offered (the
 * order is part of the cached prompt prefix: append new tools at the end).
 * The frontend renders tools by these names.
 */
export const TOOL_NAMES = {
  // @artemis/tools workspace tools
  readFile: 'read_file',
  writeFile: 'write_file',
  editFile: 'edit_file',
  deleteFile: 'delete_file',
  listFiles: 'list_files',
  searchFiles: 'search_files',
  bash: 'bash',
  // agent-server task tools
  runAgent: 'run_agent',
  listTasks: 'list_tasks',
  getTask: 'get_task',
  stopTask: 'stop_task',
  // agent-server conversation tools
  present: 'present',
  setCallMode: 'set_call_mode',
  endCall: 'end_call',
  // @artemis/mcp bridge
  mcpDescribe: 'mcp_describe',
  mcpCall: 'mcp_call',
  mcpCallWrite: 'mcp_call_write',
  // agent-server memory tools (MemoryStore)
  memorySearch: 'memory_search',
  memoryRemember: 'memory_remember',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/** Default delay before a foreground `bash` command moves to the background (10 s). */
export const DEFAULT_BACKGROUND_AFTER_MS = 10_000;
/** Default / maximum `bash` timeout for synchronous runs (2 min / 10 min). */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
