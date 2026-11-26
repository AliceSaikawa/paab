-- Pending agent descriptions submitted for approval (#37, docs/design.md section 5.4).
--
-- Holds at most one unapproved draft per agent. An agent's public
-- agents.description stays unchanged until approved by the admin bot or owner.

CREATE TABLE pending_descriptions (
	agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
	description TEXT NOT NULL,
	submitted_at INTEGER NOT NULL
) STRICT;
