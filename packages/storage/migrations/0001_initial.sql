-- Agent-server schema, database `artemis` (the `hindsight` database on the same
-- pgvector instance belongs to Hindsight and is never touched from here).
-- Applied by packages/storage/src/postgres/migrator.ts in file-name order,
-- each file in its own transaction, recorded in schema_migrations.

CREATE TABLE conversations (
  id                     uuid PRIMARY KEY,
  title                  text,
  title_source           text CHECK (title_source IN ('auto', 'user')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  last_message_at        timestamptz,
  archived_at            timestamptz,
  mcp_tool_names_shown   text[]
);
CREATE INDEX conversations_recent_idx
  ON conversations ((coalesce(last_message_at, created_at)) DESC, id)
  WHERE archived_at IS NULL;

-- Frozen system prompt + tool definitions per conversation (and per subagent task).
CREATE TABLE prompt_snapshots (
  id              uuid PRIMARY KEY,
  owner_kind      text NOT NULL CHECK (owner_kind IN ('conversation', 'task')),
  owner_id        text NOT NULL,
  system_prompt   text NOT NULL,
  tools           jsonb NOT NULL,
  template_id     text NOT NULL,
  template_hash   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_kind, owner_id)
);

CREATE TABLE turns (
  id                    uuid PRIMARY KEY,
  conversation_id       uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq                   integer NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('user', 'update')),
  modality              text NOT NULL CHECK (modality IN ('text', 'voice')),
  mode                  text NOT NULL CHECK (mode IN ('text', 'voice-short', 'voice-long')),
  effort                text,
  status                text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  error                 text,
  client_message_id     text,
  model                 text,
  usage                 jsonb,
  recall                jsonb,
  started_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  memory_retention_id   uuid,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX turns_unanalyzed_idx ON turns (conversation_id, seq)
  WHERE memory_retention_id IS NULL AND status = 'completed';
CREATE INDEX turns_running_idx ON turns (status) WHERE status = 'running';

-- Tasks: background commands and subagent workers.
CREATE TABLE tasks (
  id                     text PRIMARY KEY,
  conversation_id        uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('agent', 'command')),
  status                 text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  title                  text NOT NULL,
  prompt                 text,
  subagent_type          text,
  command                text,
  cwd                    text,
  exit_code              integer,
  stdout_tail            text,
  stderr_tail            text,
  output_path            text,
  report                 text,
  needs_input            boolean NOT NULL DEFAULT false,
  origin_mode            text NOT NULL CHECK (origin_mode IN ('text', 'voice-short', 'voice-long')),
  origin_turn_id         uuid REFERENCES turns (id) ON DELETE SET NULL,
  origin_tool_call_id    text,
  parent_task_id         text REFERENCES tasks (id) ON DELETE SET NULL,
  resumed_from_task_id   text REFERENCES tasks (id) ON DELETE SET NULL,
  depth                  integer NOT NULL DEFAULT 0,
  model                  text,
  usage                  jsonb,
  started_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz,
  stop_requested_at      timestamptz
);
CREATE INDEX tasks_conversation_idx ON tasks (conversation_id, started_at DESC);
CREATE INDEX tasks_running_idx ON tasks (status) WHERE status = 'running';

-- Every LLM message of every transcript: the conversation's (task_id NULL) and each subagent task's.
CREATE TABLE messages (
  id                    uuid PRIMARY KEY,
  conversation_id       uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  task_id               text REFERENCES tasks (id) ON DELETE CASCADE,
  turn_id               uuid REFERENCES turns (id) ON DELETE SET NULL,
  seq                   bigint NOT NULL,
  role                  text NOT NULL CHECK (role IN ('user', 'assistant')),
  content               jsonb NOT NULL,
  envelope              jsonb,
  provider              text,
  model                 text,
  provider_message_id   text,
  stop_reason           text,
  usage                 jsonb,
  timings               jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX messages_order_idx ON messages (conversation_id, (coalesce(task_id, '')), seq);
CREATE INDEX messages_turn_idx ON messages (turn_id);

CREATE TABLE tool_calls (
  id                     text PRIMARY KEY,
  conversation_id        uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  task_id                text REFERENCES tasks (id) ON DELETE CASCADE,
  turn_id                uuid REFERENCES turns (id) ON DELETE SET NULL,
  assistant_message_id   uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  name                   text NOT NULL,
  input                  jsonb NOT NULL,
  status                 text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'backgrounded', 'cancelled')),
  result_text            text,
  is_error               boolean NOT NULL DEFAULT false,
  display                jsonb,
  task_ref               jsonb,
  started_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz
);
CREATE INDEX tool_calls_message_idx ON tool_calls (assistant_message_id);

CREATE TABLE background_updates (
  id                   uuid PRIMARY KEY,
  conversation_id      uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  task_id              text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  title                text NOT NULL,
  status               text NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
  needs_input          boolean NOT NULL DEFAULT false,
  report               text NOT NULL,
  duration_ms          integer,
  depth                integer NOT NULL DEFAULT 0,
  delivery             text NOT NULL CHECK (delivery IN ('held', 'queued', 'inflight', 'delivered')),
  delivery_token       text,
  delivery_from        text CHECK (delivery_from IN ('held', 'queued')),
  delivered_turn_id    uuid REFERENCES turns (id) ON DELETE SET NULL,
  unread               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  delivered_at         timestamptz,
  read_at              timestamptz,
  UNIQUE (task_id)
);
CREATE INDEX background_updates_conversation_idx ON background_updates (conversation_id, delivery);

-- Single-row shared MCP server list (Settings -> MCP servers), with optimistic revision.
CREATE TABLE mcp_settings (
  id                integer PRIMARY KEY CHECK (id = 1),
  servers           jsonb NOT NULL,
  invalid_entries   jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision          text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_state (
  key          text PRIMARY KEY,
  value        jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Outbox of turn batches sent to Hindsight (retain), retried until submitted.
CREATE TABLE memory_retentions (
  id               uuid PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  turn_ids         uuid[] NOT NULL,
  document_id      text NOT NULL,
  operation_id     uuid NOT NULL UNIQUE,
  reason           text NOT NULL CHECK (reason IN ('batch', 'flush')),
  status           text NOT NULL CHECK (status IN ('pending', 'submitted', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz
);
CREATE INDEX memory_retentions_pending_idx ON memory_retentions (created_at) WHERE status = 'pending';

ALTER TABLE turns
  ADD CONSTRAINT turns_memory_retention_fk
  FOREIGN KEY (memory_retention_id) REFERENCES memory_retentions (id) ON DELETE SET NULL;

-- Memories already injected per conversation (avoid repeating recalled facts).
CREATE TABLE conversation_recalls (
  conversation_id   uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  memory_id         text NOT NULL,
  turn_id           uuid REFERENCES turns (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, memory_id)
);
