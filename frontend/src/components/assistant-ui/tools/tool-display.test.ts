import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolDisplay, ToolTaskRef } from '@shared/chat-types';
import {
  commandIsBackground,
  getToolGroupDisplay,
  getToolGroupLabel,
  toolCall,
  toolCallLabel,
  webSearchQuery,
} from './tool-display.ts';

const bridge = (toolName: string, args: unknown, ui = {}) =>
  toolCall(toolName, JSON.stringify(args), ui);
const bash = (args: unknown, ui = {}) => bridge('bash', args, ui);
const commandDisplay = (display: Partial<Extract<ToolDisplay, { type: 'command' }>>): ToolDisplay => ({
  type: 'command',
  command: 'sleep 5',
  ...display,
});
const commandTask: ToolTaskRef = { taskId: 'bash_1', kind: 'command', relation: 'backgrounded' };

test('only background command tool labels gain the background prefix', () => {
  const plain = bash({ command: 'sleep 5', description: 'Wait five seconds' }, {
    display: commandDisplay({ description: 'Wait five seconds', exitCode: 0, stdout: 'done' }),
  });
  assert.equal(commandIsBackground(plain), false);
  assert.equal(toolCallLabel(plain), 'Wait five seconds');

  const handoff = bash({ command: 'sleep 5', description: 'Wait five seconds' }, {
    display: commandDisplay({
      description: 'Wait five seconds',
      background: { taskId: 'bash_1', reason: 'handoff' },
    }),
    task: commandTask,
  });
  assert.equal(commandIsBackground(handoff), true);
  assert.equal(
    toolCallLabel(handoff, undefined, commandIsBackground(handoff)),
    '(background) Wait five seconds'
  );

  const requested = bash({ command: 'sleep 5', run_in_background: true });
  assert.equal(commandIsBackground(requested), true);
  assert.equal(commandIsBackground(bash({ command: 'sleep 5' }), true), true);
  assert.equal(commandIsBackground(bridge('read_file', { path: 'a.txt', run_in_background: true })), false);
});

test('worker tool calls identify the agent and its launch', () => {
  assert.equal(
    toolCallLabel(bridge('run_agent', { description: '🧮 Multiplication', prompt: 'x' })),
    '🧮 Multiplication - Agent started'
  );
  assert.equal(
    toolCallLabel(bridge('run_agent', { description: '🧮 Multiplication' }), '🧮 Multiplication'),
    '🧮 Multiplication - Agent started'
  );
});

test("Exa's tools are recognised by their own name, whatever the server is called", () => {
  const search = bridge('mcp_call', {
    tool: 'mcp__Exa__web_search_exa',
    arguments: { query: 'latest news' },
  });
  assert.equal(toolCallLabel(search), 'Searched the web');
  assert.equal(webSearchQuery(search), 'latest news');
  const fetch = bridge('mcp_call', { tool: 'mcp__web__web_fetch_exa', arguments: {} });
  assert.equal(toolCallLabel(fetch), 'Visited web page');
  assert.equal(webSearchQuery(fetch), undefined);
  const research = bridge('mcp_call_write', { tool: 'mcp__exa__agent_run' });
  assert.equal(toolCallLabel(research), 'Deep research');
});

test('a bare tool name and arguments as a JSON string work too', () => {
  const search = bridge('mcp_call', { tool: 'web_search_exa', arguments: '{"query":"q"}' });
  assert.equal(webSearchQuery(search), 'q');
});

test('other MCP tools keep the generic display', () => {
  const other = bridge('mcp_call', { tool: 'mcp__deepwiki__read_wiki_structure' });
  assert.equal(toolCallLabel(other), 'Used read_wiki_structure (deepwiki)');
  assert.equal(webSearchQuery(other), undefined);
});

const webSearch = bridge('mcp_call', {
  tool: 'mcp__Exa__web_search_exa',
  arguments: { query: 'q' },
});
const webVisit = bridge('mcp_call', { tool: 'mcp__Exa__web_fetch_exa', arguments: {} });
const findTools = [bridge('mcp_describe', { tool: 'mcp__Exa__web_search_exa' })];

test('reading about MCP tools does not name or count in a group', () => {
  const calls = [...findTools, webSearch];
  assert.equal(getToolGroupDisplay(calls), getToolGroupDisplay([webSearch]));
  assert.equal(getToolGroupLabel(calls), 'Searched online');
});

test('web groups say whether pages were visited, and how many', () => {
  assert.equal(getToolGroupLabel([webSearch, webSearch]), 'Searched online');
  assert.equal(getToolGroupLabel([webSearch, webVisit]), 'Searched online · visited 1 page');
  assert.equal(
    getToolGroupLabel([...findTools, webVisit, webVisit, webVisit]),
    'Searched online · visited 3 pages'
  );
});

test('group labels are singular for one call', () => {
  const read = bridge('read_file', { path: '/a.txt' });
  assert.equal(getToolGroupLabel([...findTools, read]), 'Opened 1 file');
  assert.equal(getToolGroupLabel([read, read]), 'Opened 2 files');
  assert.equal(toolCallLabel(bridge('write_file', { path: 'out/report.md' })), 'Wrote report.md');
});

test('a group of only descriptions keeps its own label', () => {
  assert.equal(getToolGroupLabel(findTools), 'Made 1 MCP call');
});

test('worker launches show started without an extra icon; follow-ups show restarted', () => {
  const fresh = bridge('run_agent', { description: '🧮 Multiplication' });
  assert.equal(getToolGroupDisplay([fresh]).hideIcon, true);
  assert.equal(
    toolCallLabel(bridge('run_agent', { description: '🧮 Multiplication', resume_task_id: 'task_1' })),
    'Agent - Agent restarted: Multiplication'
  );
  assert.equal(
    toolCallLabel(
      bridge('run_agent', { description: '🧮 Multiplication' }, {
        display: { type: 'agent', taskId: 'task_2', subagentType: 'general-purpose', title: 'x', prompt: 'p', resumedFromTaskId: 'task_1' },
      })
    ),
    'Agent - Agent restarted: Multiplication'
  );
  assert.equal(toolCallLabel(bridge('run_agent', {})), 'Agent - Agent started');
});

test('rerun labels retain the first agent name and append the new assignment', () => {
  assert.equal(
    toolCallLabel(
      bridge('run_agent', { resume_task_id: 'task_1', description: '🔢 Explain power' }),
      '🔢 Power'
    ),
    '🔢 Power - Agent restarted: Explain power'
  );
  assert.equal(
    toolCallLabel(bridge('run_agent', { description: '🔢 Power' }), '🔢 Power'),
    '🔢 Power - Agent started'
  );
});

test('a call without a display falls back to its tool name', () => {
  assert.equal(toolCallLabel(bridge('some_tool', {})), 'some_tool');
  assert.equal(toolCallLabel(bridge('end_call', {})), 'Ended the call');
});

test('memory calls say what was searched for or remembered', () => {
  assert.equal(toolCallLabel(bridge('memory_search', { query: 'dentist appointment' })), 'Searching memory: dentist appointment');
  assert.equal(toolCallLabel(bridge('memory_search', {})), 'Searching memory');
  assert.equal(toolCallLabel(bridge('memory_remember', { content: 'Lucas prefers metric units' })), 'Remembering: Lucas prefers metric units');
  assert.equal(toolCallLabel(bridge('memory_remember', {})), 'Remembering');
});

test('long memory text is cut to one line in its label', () => {
  const long = `first line\n\n${'word '.repeat(40)}`;
  const label = toolCallLabel(bridge('memory_remember', { content: long }));
  assert.ok(label.startsWith('Remembering: first line word word'));
  assert.ok(label.endsWith('…'));
  assert.ok(!label.includes('\n'));
  assert.ok(label.length <= 'Remembering: '.length + 60);
});

test('memory groups count searches and saves separately', () => {
  const search = bridge('memory_search', { query: 'q' });
  const remember = bridge('memory_remember', { content: 'c' });
  assert.equal(getToolGroupLabel([search]), 'Ran 1 memory search');
  assert.equal(getToolGroupLabel([search, search]), 'Ran 2 memory searches');
  assert.equal(getToolGroupLabel([remember]), 'Saved 1 memory');
  assert.equal(getToolGroupLabel([remember, remember]), 'Saved 2 memories');
});
