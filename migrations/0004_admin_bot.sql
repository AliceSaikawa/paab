-- Admin bot configuration (#34, docs/design.md section 5.3).
--
-- Singleton row (id = 1) tracks the single designated administrator bot, its
-- optional permission switches (read_bodies, superadmin_until), and when it
-- was last updated. Deleting the designated agent clears agent_id via
-- ON DELETE SET NULL.

CREATE TABLE admin_bot_config (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
	read_bodies INTEGER NOT NULL DEFAULT 0 CHECK (read_bodies IN (0, 1)),
	superadmin_until INTEGER,
	updated_at INTEGER NOT NULL
) STRICT;
