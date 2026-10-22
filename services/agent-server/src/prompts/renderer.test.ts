import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { PromptRenderer } from './renderer.ts';

const REAL_PROMPTS = fileURLToPath(new URL('../../prompts', import.meta.url));
const KNOWN_PLACEHOLDERS = new Set(['name', 'workspace', 'conversation_id', 'timezone', 'task_id', 'mcp_tools']);

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prompts-'));
  await writeFile(join(dir, 'system.md'), 'You are {{name}} in {{workspace}} ({{conversation_id}}, {{timezone}}). {{unknown}}\n\n');
  await writeFile(join(dir, 'worker-rules.md'), 'Task {{task_id}}.\n\nTools:\n{{mcp_tools}}\n');
  await writeFile(join(dir, 'title.md'), '  Name the chat.  \n');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PromptRenderer', () => {
  it('fills the system template and keeps unknown placeholders', async () => {
    const rendered = await new PromptRenderer(dir).system({
      name: 'Artemis',
      workspace: '/workspace',
      conversationId: 'conv_1',
      timezone: 'Europe/Paris',
    });
    assert.equal(rendered.templateId, 'system');
    assert.equal(rendered.systemPrompt, 'You are Artemis in /workspace (conv_1, Europe/Paris). {{unknown}}');
  });

  it('changes the template hash with the source', async () => {
    const renderer = new PromptRenderer(dir);
    const vars = { name: 'A', workspace: '/w', conversationId: 'c', timezone: 'UTC' };
    const before = await renderer.system(vars);
    const again = await renderer.system(vars);
    assert.equal(before.templateHash, again.templateHash);
    await writeFile(join(dir, 'system.md'), 'Edited {{name}}.');
    try {
      const edited = await renderer.system(vars);
      assert.notEqual(edited.templateHash, before.templateHash);
      assert.equal(edited.systemPrompt, 'Edited A.');
    } finally {
      await writeFile(join(dir, 'system.md'), 'You are {{name}} in {{workspace}} ({{conversation_id}}, {{timezone}}). {{unknown}}\n\n');
    }
  });

  it('composes subagent prompts from the definition and the worker rules', async () => {
    const rendered = await new PromptRenderer(dir).subagent({
      definition: 'Do the research.',
      name: 'research',
      workspace: '/w',
      conversationId: 'conv_1',
      taskId: 'task_9',
      mcpTools: '- device_phone__ring',
    });
    assert.equal(rendered.templateId, 'agent:research');
    assert.equal(rendered.systemPrompt, 'Do the research.\n\nTask task_9.\n\nTools:\n- device_phone__ring');
  });

  it('renders the title prompt trimmed', async () => {
    const rendered = await new PromptRenderer(dir).title();
    assert.equal(rendered.templateId, 'title');
    assert.equal(rendered.systemPrompt, 'Name the chat.');
  });
});

describe('shipped prompt templates', () => {
  it('use only known placeholders and no legacy-framework wording', async () => {
    for (const file of ['system.md', 'worker-rules.md', 'title.md']) {
      const source = await readFile(join(REAL_PROMPTS, file), 'utf8');
      for (const match of source.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
        assert.ok(KNOWN_PLACEHOLDERS.has(match[1] ?? ''), `${file} uses unknown placeholder ${match[0]}`);
      }
      // Pattern built from parts so this test file itself stays clean of the legacy name.
      assert.doesNotMatch(source, new RegExp(['le', 'tta'].join(''), 'i'), `${file} still mentions the legacy framework`);
    }
  });
});
