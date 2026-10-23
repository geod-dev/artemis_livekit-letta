-- Enforce the owner of prompt_snapshots. owner_kind and owner_id stay for compatibility; the new
-- conversation_id / task_id columns are real foreign keys (ON DELETE CASCADE), so deleting a conversation
-- (and with it its tasks) deletes its snapshots instead of leaving orphans behind.
-- Exactly one of the two is set, the one that matches owner_kind.

ALTER TABLE prompt_snapshots
  ADD COLUMN conversation_id uuid REFERENCES conversations (id) ON DELETE CASCADE,
  ADD COLUMN task_id text REFERENCES tasks (id) ON DELETE CASCADE;

-- Orphaned rows: snapshots whose owner no longer exists (their conversation, or their task, was deleted
-- before this migration, when owner_id had no foreign key). They cannot satisfy the new foreign keys, so
-- they are DELETED here, before the backfill. This removes data for conversations and tasks that are already
-- gone. The comparison is done as text so that owner_id is never cast on rows of the other kind.
DELETE FROM prompt_snapshots
 WHERE owner_kind = 'conversation'
   AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id::text = lower(prompt_snapshots.owner_id));
DELETE FROM prompt_snapshots
 WHERE owner_kind = 'task'
   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = prompt_snapshots.owner_id);

-- Backfill from the existing owner columns. The uuid cast only happens for conversation owners (CASE), and
-- every remaining conversation owner matches a conversation, so the cast cannot fail.
UPDATE prompt_snapshots
   SET conversation_id = CASE WHEN owner_kind = 'conversation' THEN owner_id::uuid END,
       task_id         = CASE WHEN owner_kind = 'task' THEN owner_id END;

ALTER TABLE prompt_snapshots
  ADD CONSTRAINT prompt_snapshots_owner_link_check CHECK (
    (owner_kind = 'conversation' AND conversation_id IS NOT NULL AND task_id IS NULL)
    OR (owner_kind = 'task' AND task_id IS NOT NULL AND conversation_id IS NULL)
  );

CREATE INDEX prompt_snapshots_conversation_idx ON prompt_snapshots (conversation_id);
CREATE INDEX prompt_snapshots_task_idx ON prompt_snapshots (task_id);
