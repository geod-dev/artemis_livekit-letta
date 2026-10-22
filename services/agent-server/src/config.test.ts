import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from './config.ts';

const base = { DATABASE_URL: 'postgresql://artemis:secret@localhost:5432/artemis' };

describe('loadConfig', () => {
  it('requires DATABASE_URL', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  });

  it('applies the documented defaults', () => {
    const config = loadConfig({ ...base, WORKSPACE_PATH: '/tmp/ws' });
    assert.equal(config.port, 4000);
    assert.equal(config.token, 'dev-agent-server-token-change-me');
    assert.equal(config.production, false);
    assert.equal(config.assistant.name, 'Artemis');
    assert.equal(config.assistant.timezone, 'UTC');
    assert.equal(config.assistant.presentTool, false);
    assert.equal(config.models.assistant, 'anthropic/claude-haiku-5-5');
    assert.equal(config.models.task, 'openai-compatible/zai-org/GLM-5.3-Flash');
    assert.equal(config.models.title, config.models.assistant);
    assert.equal(config.workers.idleTimeoutMs, 120_000);
    assert.equal(config.workers.backgroundAfterMs, 10_000);
    assert.equal(config.memory.enabled, false);
    assert.equal(config.memory.retainEvery, 3);
    assert.deepEqual(config.workspace.readOnlyPrefixes, ['data/']);
    assert.equal(config.providers.openAiCompatible, undefined);
  });

  it('reads the gateway port and token from the same variables the gateway uses', () => {
    const config = loadConfig({ ...base, AGENT_SERVER_PORT: '4100', AGENT_SERVER_TOKEN: 'shared-token' });
    assert.equal(config.port, 4100);
    assert.equal(config.token, 'shared-token');
  });

  it('refuses the development token in production', () => {
    assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /AGENT_SERVER_TOKEN/);
    const config = loadConfig({ ...base, NODE_ENV: 'production', AGENT_SERVER_TOKEN: 'real-secret' });
    assert.equal(config.production, true);
  });

  it('routes the title model to ASSISTANT_TITLE_MODEL when set', () => {
    const config = loadConfig({ ...base, ASSISTANT_MODEL: 'anthropic/claude-haiku-5-5', ASSISTANT_TITLE_MODEL: 'anthropic/other' });
    assert.equal(config.models.title, 'anthropic/other');
  });

  it('enables memory only when HINDSIGHT_URL is set', () => {
    const config = loadConfig({ ...base, HINDSIGHT_URL: 'http://hindsight:8888', MEMORY_RETAIN_EVERY: '5' });
    assert.equal(config.memory.enabled, true);
    assert.equal(config.memory.hindsightUrl, 'http://hindsight:8888');
    assert.equal(config.memory.retainEvery, 5);
    assert.equal(config.memory.bankId, 'artemis');
  });

  it('requires a key with the OpenAI-compatible base URL', () => {
    assert.throws(() => loadConfig({ ...base, OPENAI_COMPATIBLE_BASE_URL: 'https://api.telnyx.com/v2/ai/openai' }), /OPENAI_COMPATIBLE_API_KEY/);
    const config = loadConfig({
      ...base,
      OPENAI_COMPATIBLE_BASE_URL: 'https://api.telnyx.com/v2/ai/openai',
      OPENAI_COMPATIBLE_API_KEY: 'key',
    });
    assert.deepEqual(config.providers.openAiCompatible, { baseUrl: 'https://api.telnyx.com/v2/ai/openai', apiKey: 'key' });
  });

  it('rejects malformed values', () => {
    assert.throws(() => loadConfig({ ...base, ASSISTANT_TIMEZONE: 'Mars/Olympus' }), /ASSISTANT_TIMEZONE/);
    assert.throws(() => loadConfig({ ...base, AGENT_SERVER_PORT: '0' }), /AGENT_SERVER_PORT/);
    assert.throws(() => loadConfig({ ...base, WORKER_IDLE_TIMEOUT_MS: 'soon' }), /WORKER_IDLE_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ ...base, ASSISTANT_MODEL: 'claude-haiku-5-5' }), /provider\/model/);
  });
});
