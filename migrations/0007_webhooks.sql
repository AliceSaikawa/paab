-- Agent webhook endpoints and delivery queue (#42, docs/agent-trigger-design.md section 4).
--
-- Stores one optional webhook endpoint per agent with one of four auth modes
-- (standard_webhooks, bearer_header, custom_header, paab_hmac) and a delivery
-- queue that coalesces multiple pending wakes per agent into a single row.
-- Deleting an agent cascades to both tables.

CREATE TABLE agent_webhooks (
	agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	auth_mode TEXT NOT NULL CHECK (
		auth_mode IN ('standard_webhooks', 'bearer_header', 'custom_header', 'paab_hmac')
	),
	header_name TEXT,
	secret TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	CHECK ((auth_mode = 'custom_header') = (header_name IS NOT NULL))
) STRICT;

CREATE TABLE webhook_deliveries (
	id TEXT PRIMARY KEY NOT NULL,
	agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'abandoned')),
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at INTEGER NOT NULL,
	leased_until INTEGER,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX webhook_deliveries_pending_agent_idx
	ON webhook_deliveries (agent_id) WHERE status = 'pending';

CREATE INDEX webhook_deliveries_due_idx
	ON webhook_deliveries (next_attempt_at, leased_until) WHERE status = 'pending';

CREATE INDEX webhook_deliveries_agent_updated_idx
	ON webhook_deliveries (agent_id, updated_at DESC);
