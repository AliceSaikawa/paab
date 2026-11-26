-- Allow agents and categories to be deleted once they have messages (#24).
--
-- Decision: messages are delivery state, not history. The audit log is the
-- record that survives a deletion, which is why it has no foreign keys on
-- purpose. So deleting an agent or a category deletes the messages that
-- mention it (ON DELETE CASCADE), and replies go with their question
-- (in_reply_to also cascades). The asker of an unanswered question is NOT
-- sent a rejection: any rejection row would point at a question the
-- deletion removes, so it could not survive the deletion anyway. Deletion
-- is a deliberate human action (design 5.2) and is recorded in the change
-- log that #29 adds; the asker simply finds the question gone and can ask
-- again.
--
-- SET NULL is not used: the CHECK constraints require a question to have a
-- sender, a recipient and a category, so a nulled reference would break the
-- row's invariants. Soft deletion is not used either: keeping every row
-- forever contradicts the rule that the bridge holds undelivered messages,
-- rules and the audit log only (design 1).

PRAGMA defer_foreign_keys = true;

CREATE TABLE messages_new (
	id TEXT PRIMARY KEY NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('question', 'answer', 'rejection')),
	from_agent_id TEXT REFERENCES agents (id) ON DELETE CASCADE,
	to_agent_id TEXT REFERENCES agents (id) ON DELETE CASCADE,
	category_id TEXT REFERENCES categories (id) ON DELETE CASCADE,
	body TEXT,
	in_reply_to TEXT REFERENCES messages_new (id) ON DELETE CASCADE,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	received_at INTEGER,
	expires_at INTEGER,
	body_deleted_at INTEGER,
	CHECK (
		(kind = 'question' AND status IN ('pending', 'answered', 'declined', 'expired', 'blocked'))
		OR (kind <> 'question' AND status = 'sent')
	),
	CHECK ((kind = 'question') = (in_reply_to IS NULL)),
	CHECK (from_agent_id IS NOT NULL OR kind = 'rejection'),
	CHECK (to_agent_id IS NOT NULL OR status = 'blocked'),
	CHECK (category_id IS NOT NULL OR status = 'blocked' OR kind = 'rejection'),
	CHECK (kind <> 'question' OR status = 'blocked' OR expires_at IS NOT NULL)
) STRICT;

INSERT INTO messages_new SELECT * FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX messages_inbox_idx
	ON messages (to_agent_id, status, created_at)
	WHERE received_at IS NULL;

CREATE INDEX messages_daily_questions_idx
	ON messages (from_agent_id, created_at)
	WHERE kind = 'question';

CREATE INDEX messages_expiry_idx
	ON messages (expires_at)
	WHERE status = 'pending';

CREATE UNIQUE INDEX messages_reply_idx
	ON messages (in_reply_to)
	WHERE in_reply_to IS NOT NULL;
