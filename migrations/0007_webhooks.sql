-- Agent wake-up webhooks and bounded delivery retries (#42, docs/design.md section 2.3).
--
-- Holds one optional HTTPS callback URL and signing secret per agent, plus a
-- coalesced delivery queue that retries failed wake-ups up to three attempts.

CREATE TABLE agent_webhooks (
	agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	signing_secret TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE webhook_deliveries (
	id TEXT PRIMARY KEY NOT NULL,
	agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'abandoned')),
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER NOT NULL,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX webhook_deliveries_due_idx
	ON webhook_deliveries (status, next_attempt_at);
