import type { UnixMillis } from "../types";
import { type AuditBodyConfig, isBodyRecordingEnabled } from "./config";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes message bodies from audit log entries whose retention period has
 * passed, and returns how many entries were changed. The entries themselves
 * stay.
 *
 * A body is removed once `occurredAt + bodyRetentionDays` days is at or
 * before `now`. While body recording is disabled no body may be kept at all,
 * so every remaining body is removed; this cleans up after recording has
 * been switched off.
 *
 * Unlike `recordAuditEvent`, this rejects when the database fails, so that
 * the scheduled job calling it can report the failure.
 */
export async function purgeExpiredAuditBodies(
	db: D1Database,
	config: AuditBodyConfig,
	now: UnixMillis,
): Promise<number> {
	const statement = isBodyRecordingEnabled(config)
		? db
				.prepare(
					"UPDATE audit_log SET body = NULL WHERE body IS NOT NULL AND occurred_at <= ?",
				)
				.bind(now - config.bodyRetentionDays * DAY_MS)
		: db.prepare("UPDATE audit_log SET body = NULL WHERE body IS NOT NULL");
	const result = await statement.run();
	return result.meta.changes;
}
