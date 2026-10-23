import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  loadSubagentDefinitions,
  needsUserInput,
  parseSubagentDefinition,
} from './definitions.ts';

const REAL_AGENTS = fileURLToPath(new URL('../../prompts/agents', import.meta.url));

describe('parseSubagentDefinition', () => {
  it('reads name, description and the body', () => {
    const definition = parseSubagentDefinition(
      '---\nname: research\ndescription: Looks things up.\ntools: Bash, Read\n---\nDo the research.\n'
    );
    assert.deepEqual(definition, {
      name: 'research',
      description: 'Looks things up.',
      instructions: 'Do the research.',
    });
  });

  it('rejects a missing frontmatter, name or description', () => {
    assert.throws(() => parseSubagentDefinition('no frontmatter'), /frontmatter/);
    assert.throws(() => parseSubagentDefinition('---\ndescription: x\n---\nbody'), /name/);
    assert.throws(() => parseSubagentDefinition('---\nname: research\n---\nbody'), /description/);
  });
});

describe('loadSubagentDefinitions', () => {
  it('loads the shipped general-purpose and research workers', async () => {
    const definitions = await loadSubagentDefinitions(REAL_AGENTS);
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      ['general-purpose', 'research']
    );
    for (const definition of definitions) {
      assert.ok(definition.description.length > 0);
      assert.ok(definition.instructions.length > 0);
    }
  });

  it('rejects duplicate names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-'));
    try {
      await writeFile(join(dir, 'a.md'), '---\nname: same\ndescription: one\n---\nA');
      await writeFile(join(dir, 'b.md'), '---\nname: same\ndescription: two\n---\nB');
      await assert.rejects(loadSubagentDefinitions(dir), /Duplicate subagent name: same/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('needsUserInput', () => {
  it('detects the prefix on the first non-blank line only', () => {
    assert.equal(needsUserInput('NEEDS USER INPUT: which city?'), true);
    assert.equal(needsUserInput('\n  \nNEEDS USER INPUT: which city?'), true);
    assert.equal(needsUserInput('Here is the report.\nNEEDS USER INPUT: later'), false);
    assert.equal(needsUserInput(''), false);
  });
});
