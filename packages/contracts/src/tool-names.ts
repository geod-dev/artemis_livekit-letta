/**
 * Every tool name the agents can see, in the order they are offered (the
 * order is part of the cached prompt prefix: append new tools at the end).
 * The agent-server registers tools by these names and the frontend renders
 * them by the same names.
 */
export const TOOL_NAMES = {
  // workspace tools (@artemis/tools)
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
  // MCP bridge (@artemis/mcp)
  mcpDescribe: 'mcp_describe',
  mcpCall: 'mcp_call',
  mcpCallWrite: 'mcp_call_write',
  // agent-server memory tools (MemoryStore)
  memorySearch: 'memory_search',
  memoryRemember: 'memory_remember',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
