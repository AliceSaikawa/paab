import { type MessageRow, newId } from "../db";
import type { UnixMillis } from "../types";
import { BODY_RETENTION_MS } from "./constants";

/** A question the maintenance run just expired, for the audit log. */
export interface ExpiredQuestion {
	questionId: string;
	fromAgentId: string;
	toAgentId: string;
	categoryId: string;
}

export interface InboxMaintenanceResult {
	expiredQuestions: ExpiredQuestion[];
	/** Number of messages whose body was deleted in this run. */
	bodiesDeleted: number;
}

/** Questions expired per transaction (two statements each). */
const EXPIRY_CHUNK = 25;

/**
 * Expires unanswered questions whose deadline has passed, then deletes
 * message bodies that are due. Meant for the scheduled handler; running it
 * again with the same `now` changes nothing.
 */
export async function runInboxMaintenance(
	db: D1Database,
	now: UnixMillis,
): Promise<InboxMaintenanceResult> {
	const expiredQuestions = await expireQuestions(db, now);
	const bodiesDeleted = await deleteBodies(db, now);
	return { expiredQuestions, bodiesDeleted };
}

/**
 * Marks questions with `expires_at <= now` as expired and puts a rejection
 * into each asker's inbox.
 *
 * Each rejection is inserted only while its question is still pending, and
 * the question is closed in the same transaction, so an answer that arrives
 * at the deadline and this run cannot both leave a reply. `OR IGNORE` and
 * the unique index on `in_reply_to` back this up.
 */
async function expireQuestions(
	db: D1Database,
	now: UnixMillis,
): Promise<ExpiredQuestion[]> {
	const insertRejection = db.prepare(
		`INSERT OR IGNORE INTO messages
			(id, kind, from_agent_id, to_agent_id, category_id, body, in_reply_to,
			status, created_at, received_at, expires_at, body_deleted_at, available_at)
		SELECT ?1, 'rejection', NULL, from_agent_id, NULL, NULL, id,
			'sent', ?2, NULL, NULL, NULL, NULL
		FROM messages
		WHERE id = ?3 AND status = 'pending' AND expires_at <= ?2`,
	);
	const closeQuestion = db.prepare(
		`UPDATE messages SET status = 'expired'
		WHERE id = ?1 AND status = 'pending' AND expires_at <= ?2
			AND EXISTS (SELECT 1 FROM messages AS r WHERE r.in_reply_to = ?1)`,
	);

	const expired: ExpiredQuestion[] = [];
	for (;;) {
		const { results: due } = await db
			.prepare(
				`SELECT * FROM messages
				WHERE status = 'pending' AND expires_at <= ?
				ORDER BY expires_at LIMIT ?`,
			)
			.bind(now, EXPIRY_CHUNK)
			.all<MessageRow>();
		if (due.length === 0) {
			return expired;
		}

		const outcomes = await db.batch(
			due.flatMap((question) => [
				insertRejection.bind(newId(), now, question.id),
				closeQuestion.bind(question.id, now),
			]),
		);
		const before = expired.length;
		due.forEach((question, i) => {
			// Skip questions that were answered between the SELECT and the batch.
			if (outcomes[2 * i + 1].meta.changes !== 1) {
				return;
			}
			if (!question.from_agent_id || !question.to_agent_id) {
				throw new Error(`Pending question ${question.id} lacks an agent`);
			}
			if (!question.category_id) {
				throw new Error(`Pending question ${question.id} lacks a category`);
			}
			expired.push({
				questionId: question.id,
				fromAgentId: question.from_agent_id,
				toAgentId: question.to_agent_id,
				categoryId: question.category_id,
			});
		});
		// Every due question normally leaves the pending state above. Stop if
		// none did, rather than selecting the same rows forever.
		if (expired.length === before) {
			return expired;
		}
	}
}

/**
 * Deletes bodies that are no longer needed. The rows stay.
 *
 * - Closed questions (answered, declined or expired) and answers:
 *   `BODY_RETENTION_MS` after the recipient received them.
 * - Expired questions nobody ever fetched: at once. They can no longer be
 *   delivered, and without a receipt time the 24 hour rule would keep them
 *   forever.
 */
async function deleteBodies(db: D1Database, now: UnixMillis): Promise<number> {
	const result = await db
		.prepare(
			`UPDATE messages SET body = NULL, body_deleted_at = ?1
			WHERE body IS NOT NULL AND (
				(kind = 'question' AND status = 'expired' AND received_at IS NULL)
				OR (
					received_at <= ?2
					AND (
						kind = 'answer'
						OR (kind = 'question' AND status IN ('answered', 'declined', 'expired'))
					)
				)
			)`,
		)
		.bind(now, now - BODY_RETENTION_MS)
		.run();
	return result.meta.changes;
}
