-- Management change log (#29, docs/design.md section 4 and 5.3).
--
-- Records who changed configuration (agents, tokens, categories, allow rules,
-- admin bot designation/permissions, approved descriptions), when, and the
-- before/after JSON snapshots so that admin bot changes can be rolled back.
-- Token plaintext and token_hash are never written here.
--
-- action is validated in src/db/rows.ts rather than by a CHECK constraint, so
-- that later stages can add action names without rebuilding the table.

CREATE TABLE change_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	occurred_at INTEGER NOT NULL,
	actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'admin_bot')),
	actor_id TEXT NOT NULL,
	approver_id TEXT,
	action TEXT NOT NULL,
	target_type TEXT NOT NULL CHECK (target_type IN ('agent', 'token', 'category', 'allow_rule', 'admin_bot', 'description')),
	target_id TEXT NOT NULL,
	before_json TEXT,
	after_json TEXT,
	reverted_at INTEGER
) STRICT;

CREATE INDEX change_log_occurred_at_idx ON change_log (occurred_at DESC, id DESC);
CREATE INDEX change_log_target_idx ON change_log (target_type, target_id, id DESC);
