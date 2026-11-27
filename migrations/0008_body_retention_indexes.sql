-- Partial indexes so hourly body-retention sweeps scan only rows that still hold a body.
CREATE INDEX messages_with_body_idx
	ON messages (received_at, status)
	WHERE body IS NOT NULL;

CREATE INDEX audit_log_with_body_idx
	ON audit_log (occurred_at)
	WHERE body IS NOT NULL;
