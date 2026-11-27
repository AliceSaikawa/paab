import type { UnixMillis } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Revoked token rows are removed this long after revocation (design 4).
 * Token lifecycle audit stays in `change_log`.
 */
export const REVOKED_TOKEN_RETENTION_MS = 30 * DAY_MS;

const TOKEN_PURGE_CHUNK = 500;
const MAX_TOKEN_PURGE_CHUNKS = 5;

/**
 * Deletes revoked token rows with `revoked_at <= now - REVOKED_TOKEN_RETENTION_MS`.
 * Active tokens (`revoked_at IS NULL`) are never touched.
 */
export async function purgeRevokedTokens(
	db: D1Database,
	now: UnixMillis,
): Promise<number> {
	const cutoff = now - REVOKED_TOKEN_RETENTION_MS;
	const statement = db
		.prepare(
			`DELETE FROM tokens
			WHERE id IN (
				SELECT id FROM tokens
				WHERE revoked_at IS NOT NULL AND revoked_at <= ?1
				ORDER BY revoked_at ASC
				LIMIT ?2
			)`,
		)
		.bind(cutoff, TOKEN_PURGE_CHUNK);
	let deleted = 0;
	for (let chunk = 0; chunk < MAX_TOKEN_PURGE_CHUNKS; chunk += 1) {
		const result = await statement.run();
		const changes = result.meta.changes ?? 0;
		deleted += changes;
		if (changes < TOKEN_PURGE_CHUNK) {
			break;
		}
	}
	return deleted;
}
