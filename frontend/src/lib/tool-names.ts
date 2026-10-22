/**
 * The tool names the agent-server registers (`TOOL_NAMES`, in order). The UI
 * matches tool calls by these names and reads their structured `display` and
 * `task` fields; it never parses result text for them.
 */
export const TOOL_NAMES = {
  readFile: 'read_file',
  writeFile: 'write_file',
  editFile: 'edit_file',
  deleteFile: 'delete_file',
  listFiles: 'list_files',
  searchFiles: 'search_files',
  bash: 'bash',
  runAgent: 'run_agent',
  listTasks: 'list_tasks',
  getTask: 'get_task',
  stopTask: 'stop_task',
  present: 'present',
  setCallMode: 'set_call_mode',
  endCall: 'end_call',
  mcpDescribe: 'mcp_describe',
  mcpCall: 'mcp_call',
  mcpCallWrite: 'mcp_call_write',
  memorySearch: 'memory_search',
  memoryRemember: 'memory_remember',
} as const;
