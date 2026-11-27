import type { UnixMillis } from "../types";
import {
	type AuditBodyConfig,
	DEFAULT_AUDIT_LOG_RETENTION_DAYS,
	isBodyRecordingEnabled,
} from "./config";

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_LOG_PURGE_CHUNK = 500;
const MAX_AUDIT_LOG_PURGE_CHUNKS = 5;

/**
 * Removes message bodies from audit log entries whose retention period has
 * passed, and returns how many entries were changed. The entries themselves
 * stay until `purgeExpiredAuditLogs` removes rows past `AUDIT_LOG_RETENTION_DAYS`.
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

/**
 * Deletes audit log rows whose `occurred_at` is at or before
 * `now - retentionDays * DAY_MS`. When `retentionDays` is `0` (or not a
 * positive safe integer), deletes nothing and returns `0`.
 */
export async function purgeExpiredAuditLogs(
	db: D1Database,
	now: UnixMillis,
	retentionDays: number = DEFAULT_AUDIT_LOG_RETENTION_DAYS,
): Promise<number> {
	if (
		!Number.isSafeInteger(retentionDays) ||
		retentionDays <= 0 ||
		!Number.isSafeInteger(retentionDays * DAY_MS)
	) {
		return 0;
	}
	const cutoff = now - retentionDays * DAY_MS;
	const statement = db
		.prepare(
			`DELETE FROM audit_log
			WHERE id IN (
				SELECT id FROM audit_log
				WHERE occurred_at <= ?1
				ORDER BY occurred_at ASC, id ASC
				LIMIT ?2
			)`,
		)
		.bind(cutoff, AUDIT_LOG_PURGE_CHUNK);
	let deleted = 0;
	for (let chunk = 0; chunk < MAX_AUDIT_LOG_PURGE_CHUNKS; chunk += 1) {
		const result = await statement.run();
		const changes = result.meta.changes ?? 0;
		deleted += changes;
		if (changes < AUDIT_LOG_PURGE_CHUNK) {
			break;
		}
	}
	return deleted;
}
