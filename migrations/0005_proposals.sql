-- Admin bot proposals (#36, docs/design.md section 5.3).
--
-- Stores loosening proposals submitted by the designated admin bot until the
-- owner approves or rejects them in the Admin UI, or until they expire after
-- 14 days. Deleting the proposing agent removes its proposals via CASCADE.

CREATE TABLE proposals (
	id TEXT PRIMARY KEY NOT NULL,
	kind TEXT NOT NULL CHECK (
		kind IN (
			'grant_allow_rule',
			'create_category',
			'raise_daily_limit',
			'resume_agent'
		)
	),
	proposer_agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
	payload_json TEXT NOT NULL,
	reason TEXT NOT NULL,
	status TEXT NOT NULL CHECK (
		status IN ('pending', 'approved', 'rejected', 'expired')
	),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	resolved_at INTEGER,
	resolved_by TEXT,
	change_log_id INTEGER,
	CHECK ((status = 'pending') = (resolved_at IS NULL))
) STRICT;

CREATE INDEX proposals_status_idx ON proposals (status, created_at DESC);

CREATE INDEX proposals_expiry_idx ON proposals (expires_at)
	WHERE status = 'pending';
