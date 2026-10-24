import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertAnthropicKeyForModels, loadConfig } from './config.ts';

/** The task model defaults to an OpenAI-compatible provider; the base uses Anthropic so tests need no second key. */
const base = {
  DATABASE_URL: 'postgresql://artemis:secret@localhost:5432/artemis',
  ASSISTANT_TASK_MODEL: 'anthropic/claude-haiku-5-5',
};
const openAi = { OPENAI_COMPATIBLE_BASE_URL: 'https://api.telnyx.com/v2/ai/openai', OPENAI_COMPATIBLE_API_KEY: 'key' };

describe('loadConfig', () => {
  it('requires DATABASE_URL', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  });

  it('applies the documented defaults', () => {
    const config = loadConfig({
      DATABASE_URL: base.DATABASE_URL,
      WORKSPACE_PATH: '/tmp/ws',
      ...openAi,
    });
    assert.equal(config.port, 4000);
    assert.equal(config.token, 'dev-agent-server-token-change-me');
    assert.equal(config.assistant.name, 'Artemis');
    assert.equal(config.assistant.timezone, 'UTC');
    assert.equal(config.assistant.presentTool, false);
    assert.equal(config.models.assistant, 'anthropic/claude-haiku-5-5');
    assert.equal(config.models.task, 'openai-compatible/zai-org/GLM-5.3-Flash');
    assert.equal(config.models.title, config.models.assistant);
    assert.equal(config.workers.idleTimeoutMs, 120_000);
    assert.equal(config.workers.backgroundAfterMs, 10_000);
    assert.equal(config.workers.maxPendingTurns, 32);
    assert.equal(config.workers.maxSubagents, 4);
    assert.equal(config.memory.enabled, false);
    assert.equal(config.memory.retainEvery, 3);
    assert.deepEqual(config.workspace.readOnlyPrefixes, ['data/']);
    assert.deepEqual(config.providers.openAiCompatible, { baseUrl: openAi.OPENAI_COMPATIBLE_BASE_URL, apiKey: 'key' });
  });

  it('reads the gateway port and token from the same variables the gateway uses', () => {
    const config = loadConfig({ ...base, AGENT_SERVER_PORT: '4100', AGENT_SERVER_TOKEN: 'shared-token' });
    assert.equal(config.port, 4100);
    assert.equal(config.token, 'shared-token');
  });

  it('refuses the development token in production', () => {
    assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /AGENT_SERVER_TOKEN/);
    const config = loadConfig({ ...base, NODE_ENV: 'production', AGENT_SERVER_TOKEN: 'real-secret' });
    assert.equal(config.token, 'real-secret');
  });

  it('refuses placeholder database passwords in production', () => {
    const prod = { NODE_ENV: 'production', AGENT_SERVER_TOKEN: 'real-secret' };
    const placeholderUrl = 'postgresql://artemis:dev-artemis-db-password-change-me@localhost:5432/artemis';
    assert.throws(() => loadConfig({ ...prod, ...base, DATABASE_URL: placeholderUrl }), /DATABASE_URL password/);
    assert.throws(
      () => loadConfig({ ...prod, ...base, HINDSIGHT_DB_PASSWORD: 'dev-hindsight-db-password-change-me' }),
      /HINDSIGHT_DB_PASSWORD/
    );
    assert.doesNotThrow(() => loadConfig({ ...prod, ...base }));
    assert.doesNotThrow(() => loadConfig({ ...base, HINDSIGHT_DB_PASSWORD: 'dev-hindsight-db-password-change-me' }));
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
    const config = loadConfig({ ...base, ...openAi });
    assert.deepEqual(config.providers.openAiCompatible, { baseUrl: 'https://api.telnyx.com/v2/ai/openai', apiKey: 'key' });
  });

  it('names the variables to set when a model uses an unconfigured provider', () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: base.DATABASE_URL }),
      /ASSISTANT_TASK_MODEL uses provider openai-compatible.*OPENAI_COMPATIBLE_BASE_URL/
    );
    assert.throws(
      () => loadConfig({ ...base, ASSISTANT_MODEL: 'mystery/model' }),
      /ASSISTANT_MODEL uses unknown provider "mystery"/
    );
  });

  it('rejects malformed values', () => {
    assert.throws(() => loadConfig({ ...base, ASSISTANT_TIMEZONE: 'Mars/Olympus' }), /ASSISTANT_TIMEZONE/);
    assert.throws(() => loadConfig({ ...base, AGENT_SERVER_PORT: '0' }), /AGENT_SERVER_PORT/);
    assert.throws(() => loadConfig({ ...base, WORKER_IDLE_TIMEOUT_MS: 'soon' }), /WORKER_IDLE_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ ...base, ASSISTANT_MODEL: 'claude-haiku-5-5' }), /provider\/model/);
  });
});

describe('assertAnthropicKeyForModels', () => {
  it('refuses a model route on the anthropic provider when no key is set, and names the route', () => {
    const config = loadConfig({ ...base, ...openAi });
    assert.throws(() => assertAnthropicKeyForModels(config), /ANTHROPIC_API_KEY is required: .*assistant/);
  });

  it('accepts the same routes once the key is set, and any configuration with no anthropic route', () => {
    const keyed = loadConfig({ ...base, ...openAi, ANTHROPIC_API_KEY: 'key' });
    assert.doesNotThrow(() => assertAnthropicKeyForModels(keyed));
    const noAnthropic = loadConfig({
      DATABASE_URL: base.DATABASE_URL,
      ...openAi,
      ASSISTANT_MODEL: 'openai-compatible/model-a',
      ASSISTANT_TASK_MODEL: 'openai-compatible/model-b',
    });
    assert.doesNotThrow(() => assertAnthropicKeyForModels(noAnthropic));
  });
});
