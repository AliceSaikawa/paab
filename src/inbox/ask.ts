import { insertMessage, newId } from "../db";
import { UTC_DAY_MS, utcDayStart } from "../policy";
import type { UnixMillis } from "../types";
import { QUESTION_TTL_MS } from "./constants";
import { rejectionFor } from "./rejection";

export interface SubmitQuestionInput {
	fromAgentId: string;
	toAgentId: string;
	categoryId: string;
	body: string;
	now: UnixMillis;
}

export type SubmitQuestionResult =
	| { ok: true; questionId: string; expiresAt: UnixMillis }
	| { ok: false; reason: "daily_limit_exceeded" };

/**
 * Stores a question the bridge accepted, enforcing the sender's
 * `daily_question_limit` atomically in the same statement so concurrent
 * calls cannot exceed it. The recipient gets it on its next inbox fetch.
 * Rule matching and body validation are the caller's job.
 *
 * Throws if `fromAgentId` does not exist.
 */
export async function submitQuestion(
	db: D1Database,
	input: SubmitQuestionInput,
): Promise<SubmitQuestionResult> {
	const questionId = newId();
	const expiresAt = input.now + QUESTION_TTL_MS;
	const dayStart = utcDayStart(input.now);
	const dayEnd = dayStart + UTC_DAY_MS;
	const result = await db
		.prepare(
			`INSERT INTO messages
				(id, kind, from_agent_id, to_agent_id, category_id, body, in_reply_to,
				status, created_at, received_at, expires_at, body_deleted_at)
			SELECT ?1, 'question', ?2, ?3, ?4, ?5, NULL,
				'pending', ?6, NULL, ?7, NULL
			FROM agents
			WHERE id = ?2
				AND (
					SELECT COUNT(*) FROM messages
					WHERE kind = 'question' AND from_agent_id = ?2
						AND created_at >= ?8 AND created_at < ?9
				) < daily_question_limit`,
		)
		.bind(
			questionId,
			input.fromAgentId,
			input.toAgentId,
			input.categoryId,
			input.body,
			input.now,
			expiresAt,
			dayStart,
			dayEnd,
		)
		.run();
	if (result.meta.changes === 1) {
		return { ok: true, questionId, expiresAt };
	}
	const sender = await db
		.prepare("SELECT 1 AS found FROM agents WHERE id = ?")
		.bind(input.fromAgentId)
		.first<{ found: number }>();
	if (sender === null) {
		throw new Error(`Unknown sender agent: ${input.fromAgentId}`);
	}
	return { ok: false, reason: "daily_limit_exceeded" };
}

export interface RecordBlockedQuestionInput {
	fromAgentId: string;
	/** Null when the requested recipient does not exist. */
	toAgentId: string | null;
	/** Null when the requested category does not exist. */
	categoryId: string | null;
	now: UnixMillis;
}

/**
 * Records a question the bridge rejected and puts a rejection into the
 * asker's inbox, in one transaction. The question row counts toward the
 * asker's daily limit and is never delivered.
 *
 * The body is deliberately not taken: a blocked question is never handed to
 * anyone, so the bridge has no reason to keep its text.
 */
export async function recordBlockedQuestion(
	db: D1Database,
	input: RecordBlockedQuestionInput,
): Promise<{ questionId: string }> {
	const questionId = newId();
	await db.batch([
		insertMessage(db, {
			id: questionId,
			kind: "question",
			fromAgentId: input.fromAgentId,
			toAgentId: input.toAgentId,
			categoryId: input.categoryId,
			body: null,
			inReplyTo: null,
			status: "blocked",
			createdAt: input.now,
			receivedAt: null,
			expiresAt: null,
			bodyDeletedAt: null,
		}),
		insertMessage(
			db,
			rejectionFor({
				questionId,
				askerAgentId: input.fromAgentId,
				now: input.now,
			}),
		),
	]);
	return { questionId };
}
