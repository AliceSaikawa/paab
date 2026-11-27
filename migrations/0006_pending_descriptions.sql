-- Pending agent descriptions (#37, docs/design.md section 5.4).
--
-- Stores the latest description submitted by an agent until an admin bot or
-- the owner approves or rejects it. At most one pending description exists per
-- agent, and resubmitting overwrites it with a fresh submission_id so reviewers
-- can only approve or reject the exact revision they inspected. Deleting the
-- agent cascades here.

CREATE TABLE pending_descriptions (
	agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
	submission_id TEXT NOT NULL,
	description TEXT NOT NULL,
	submitted_at INTEGER NOT NULL
) STRICT;

CREATE INDEX pending_descriptions_submitted_idx
	ON pending_descriptions (submitted_at ASC);
