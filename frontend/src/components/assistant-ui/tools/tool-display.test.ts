import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commandIsBackground,
  getToolGroupDisplay,
  getToolGroupLabel,
  shellCommand,
  toolCall,
  toolCallLabel,
  webSearchQuery,
} from './tool-display.ts';

const bridge = (toolName: string, args: unknown) => toolCall(toolName, JSON.stringify(args));
const bash = (command: string) => toolCall('Bash', JSON.stringify({ command }));

test('only background command tool labels gain the background prefix', () => {
  const call = bridge('Bash', { command: 'sleep 5', description: 'Wait five seconds' });
  for (const receipt of [
    'Command is still running with task ID: bash_1\nOutput file: /tmp/bash_1.log',
    'Command running in background with ID: bash_1',
    [{ type: 'text', text: 'Command running in background with ID: bash_1' }],
    JSON.stringify([{ type: 'text', text: 'Command running in background with ID: bash_1' }]),
    JSON.stringify({
      content: [{ type: 'text', text: 'Command running in background with ID: bash_1' }],
    }),
  ]) {
    assert.equal(commandIsBackground(call, receipt), true);
    assert.equal(
      toolCallLabel(call, undefined, commandIsBackground(call, receipt)),
      '(background) Wait five seconds'
    );
  }
  assert.equal(commandIsBackground(call, 'Exit code: 0\nOutput: done'), false);
  assert.equal(toolCallLabel(call), 'Wait five seconds');
  assert.equal(commandIsBackground(call, undefined, true), true);
  assert.equal(commandIsBackground(bridge('Bash', { run_in_background: true }), undefined), true);
  assert.equal(
    commandIsBackground(bridge('Bash', { run_in_background: true }), 'Exit code: 0'),
    false
  );
  assert.equal(
    commandIsBackground(bridge('Read', {}), 'Command running in background with ID: bash_1'),
    false
  );
});

test('worker tool calls identify the agent and its launch separately from completion', () => {
  for (const name of ['Agent', 'Task']) {
    assert.equal(
      toolCallLabel(bridge(name, { description: '🧮 Multiplication' })),
      '🧮 Multiplication - Agent started'
    );
  }
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

test('the skill wrapper and older `letta mcp call` commands are MCP calls, not terminals', () => {
  for (const command of [
    `sh /root/.letta/skills/mcp-servers/scripts/mcp.sh call mcp__Exa__web_search_exa --args '{"query":"it'\\''s"}'`,
    `letta mcp call mcp__exa__web_search_exa --args '{"query":"it'\\''s"}'`,
  ]) {
    const call = bash(command);
    assert.equal(webSearchQuery(call), "it's");
    assert.equal(shellCommand(call), undefined);
  }
  assert.equal(shellCommand(bash('ls -la')), 'ls -la');
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
const findTools = [
  bridge('mcp_search', { query: 'search the web' }),
  bridge('mcp_describe', { tool: 'mcp__Exa__web_search_exa' }),
];

test('finding and reading about MCP tools does not name or count in a group', () => {
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
  const read = toolCall('Read', JSON.stringify({ file_path: '/a.txt' }));
  assert.equal(getToolGroupLabel([...findTools, read]), 'Opened 1 file');
  assert.equal(getToolGroupLabel([read, read]), 'Opened 2 files');
});

test('a group of only searches and descriptions keeps its own label', () => {
  assert.equal(getToolGroupLabel(findTools), 'Made 2 MCP calls');
});

test('worker follow-ups show restarted while ordinary launches show started without an extra icon', () => {
  for (const name of ['Agent', 'Task']) {
    const fresh = bridge(name, { description: '🧮 Multiplication' });
    assert.equal(getToolGroupDisplay([fresh]).hideIcon, true);
    for (const address of [
      { agent_id: 'agent-1' },
      { conversation_id: 'conv-1' },
      { agent_id: 'agent-1', conversation_id: 'default' },
    ]) {
      assert.equal(
        toolCallLabel(bridge(name, { description: '🧮 Multiplication', ...address })),
        'Agent - Agent restarted: Multiplication'
      );
    }
    assert.equal(
      toolCallLabel(bridge(name, { agent_id: '', conversation_id: ' ' })),
      'Agent - Agent started'
    );
  }
});

test('rerun labels retain the first agent name and append the new assignment', () => {
  assert.equal(
    toolCallLabel(
      bridge('Agent', {
        agent_id: 'a',
        conversation_id: 'default',
        description: '🔢 Explain power',
      }),
      '🔢 Power'
    ),
    '🔢 Power - Agent restarted: Explain power'
  );
  assert.equal(
    toolCallLabel(bridge('Agent', { description: '🔢 Power' }), '🔢 Power'),
    '🔢 Power - Agent started'
  );
});
