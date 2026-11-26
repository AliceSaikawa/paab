-- Admin bot proposals (#36, docs/design.md section 5.3).
--
-- Stores change proposals submitted by the administrator bot via /mcp/admin.
-- Proposals do not modify rules, categories, or agents until approved by a
-- human owner in /admin/proposals, and expire after 14 days.

CREATE TABLE proposals (
	id TEXT PRIMARY KEY NOT NULL,
	bot_agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('grant_allow_rule', 'create_category', 'raise_daily_limit', 'resume_agent')),
	payload_json TEXT NOT NULL,
	reason TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	resolved_at INTEGER,
	resolved_by TEXT
) STRICT;
CREATE INDEX proposals_status_expires_idx ON proposals (status, expires_at);
