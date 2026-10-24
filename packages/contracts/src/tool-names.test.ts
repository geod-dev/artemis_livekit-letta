import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_NAMES } from './tool-names.ts';

// The prompt prefix caches the offered tools in this order. Reordering or
// renaming a tool changes the prefix, so this snapshot must change on purpose.
const ORDERED_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'list_files',
  'search_files',
  'bash',
  'run_agent',
  'list_tasks',
  'get_task',
  'stop_task',
  'present',
  'set_call_mode',
  'end_call',
  'mcp_describe',
  'mcp_call',
  'mcp_call_write',
  'memory_search',
  'memory_remember',
];

test('TOOL_NAMES keeps the offered order (append new tools at the end)', () => {
  assert.deepEqual(Object.values(TOOL_NAMES), ORDERED_TOOL_NAMES);
});
