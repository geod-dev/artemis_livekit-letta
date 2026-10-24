import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadSubagentDefinitions, needsUserInput } from './definitions.ts';

const REAL_AGENTS = fileURLToPath(new URL('../../templates/agents', import.meta.url));

/** Loads one definition file written with `source`; definitions are read through the public loader. */
async function loadOne(source: string) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-def-'));
  try {
    await writeFile(join(dir, 'definition.md'), source);
    return await loadSubagentDefinitions(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('subagent definition files', () => {
  it('reads name, description and the body', async () => {
    const definitions = await loadOne(
      '---\nname: research\ndescription: Looks things up.\ntools: Bash, Read\n---\nDo the research.\n'
    );
    assert.deepEqual(definitions, [
      {
        name: 'research',
        description: 'Looks things up.',
        instructions: 'Do the research.',
      },
    ]);
  });

  it('rejects a missing frontmatter, name or description', async () => {
    await assert.rejects(loadOne('no frontmatter'), /frontmatter/);
    await assert.rejects(loadOne('---\ndescription: x\n---\nbody'), /name/);
    await assert.rejects(loadOne('---\nname: research\n---\nbody'), /description/);
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
