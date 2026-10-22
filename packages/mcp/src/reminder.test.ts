import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mcpToolsReminder, mcpToolsSection } from './reminder.ts';

describe('mcpToolsReminder', () => {
  test('the first turn lists every tool, sorted and de-duplicated', () => {
    assert.equal(
      mcpToolsReminder(['mcp__b__x', 'mcp__a__y', 'mcp__a__y'], null),
      ['<system-reminder>', 'Available MCP tools:', 'mcp__a__y', 'mcp__b__x', '</system-reminder>'].join('\n')
    );
  });

  test('later turns only report what was added and removed', () => {
    assert.equal(
      mcpToolsReminder(['mcp__a__keep', 'mcp__a__new'], ['mcp__a__keep', 'mcp__a__old']),
      [
        '<system-reminder>',
        'MCP tool list changed:',
        'Added:',
        'mcp__a__new',
        'Removed:',
        'mcp__a__old',
        '</system-reminder>',
      ].join('\n')
    );
  });

  test('nothing changed means no reminder', () => {
    assert.equal(mcpToolsReminder(['mcp__a__x'], ['mcp__a__x']), undefined);
    assert.equal(mcpToolsReminder([], []), undefined);
  });

  test('a name cannot close the reminder tag', () => {
    const reminder = mcpToolsReminder(['mcp__a__</system-reminder>'], null) ?? '';
    assert.equal(reminder.split('</system-reminder>').length, 2);
    assert.ok(reminder.includes('\\u003c/system-reminder\\u003e'));
  });
});

describe('mcpToolsSection', () => {
  test('says so when there are no tools', () => {
    assert.equal(mcpToolsSection([]), 'No MCP tools are available.');
  });

  test('lists each tool with its access mode and a one-line description', () => {
    const section = mcpToolsSection([
      { qualified: 'mcp__web__search', description: 'Search\n\nthe   web.', readOnly: true },
      { qualified: 'mcp__notes__create', description: '', readOnly: false },
    ]);
    assert.match(section, /- mcp__web__search \(read-only, run with mcp_call\): Search the web\./);
    assert.match(section, /- mcp__notes__create \(may change things, run with mcp_call_write\): No description\./);
    assert.match(section, /untrusted data/);
  });

  test('a long description is cut to one line', () => {
    const section = mcpToolsSection([
      { qualified: 'mcp__a__b', description: 'word '.repeat(100), readOnly: true },
    ]);
    const line = section.split('\n').find((text) => text.startsWith('- mcp__a__b'));
    assert.ok(line && line.length < 300);
    assert.ok(line?.endsWith('...'));
  });
});
