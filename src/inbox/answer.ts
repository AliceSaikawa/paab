import { type MessageRow, newId } from "../db";
import type { UnixMillis } from "../types";

export interface AnswerQuestionInput {
	questionId: string;
	/** The agent answering; taken from its token, never from tool input. */
	responderAgentId: string;
	/** Either an answer with its text, or a refusal to answer. */
	reply: { kind: "answer"; body: string } | { kind: "decline" };
	now: UnixMillis;
}

/**
 * Why a reply was not stored.
 * - `not_found`: no such question, or one the bridge blocked (which nobody
 *   was ever asked).
 * - `not_recipient`: the question is addressed to another agent.
 * - `already_replied`: the question was already answered or declined.
 * - `expired`: the deadline has passed, whether or not the maintenance run
 *   has marked the question yet.
 */
export type AnswerFailureReason =
	| "not_found"
	| "not_recipient"
	| "already_replied"
	| "expired";

export type AnswerResult =
	| {
			ok: true;
			/** ID of the answer or rejection now waiting in the asker's inbox. */
			replyId: string;
			askerAgentId: string;
			categoryId: string;
	  }
	| { ok: false; reason: AnswerFailureReason };

function isUniqueViolation(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes("UNIQUE constraint failed")
	);
}

/**
 * Stores the recipient's answer or refusal and closes the question.
 *
 * Both statements run in one transaction and are conditional on the question
 * still being open, so a second reply or a concurrent expiry cannot add
 * another reply. The unique index on `in_reply_to` backs this up.
 */
export async function answerQuestion(
	db: D1Database,
	input: AnswerQuestionInput,
): Promise<AnswerResult> {
	const { questionId, responderAgentId, reply, now } = input;
	const replyId = newId();
	const isAnswer = reply.kind === "answer";

	// The reply is derived from the question row, and only while the question
	// is open, addressed to the responder and before its deadline. A rejection
	// carries no sender, category or body (see `rejection.ts`).
	const insertReply = db
		.prepare(
			`INSERT INTO messages
				(id, kind, from_agent_id, to_agent_id, category_id, body, in_reply_to,
				status, created_at, received_at, expires_at, body_deleted_at)
			SELECT ?1, ?2,
				CASE WHEN ?2 = 'answer' THEN to_agent_id END,
				from_agent_id,
				CASE WHEN ?2 = 'answer' THEN category_id END,
				?3, id, 'sent', ?4, NULL, NULL, NULL
			FROM messages
			WHERE id = ?5 AND kind = 'question' AND to_agent_id = ?6
				AND status = 'pending' AND expires_at > ?4`,
		)
		.bind(
			replyId,
			isAnswer ? "answer" : "rejection",
			isAnswer ? reply.body : null,
			now,
			questionId,
			responderAgentId,
		);
	// Replying implies the recipient has the question, so it also counts as
	// received. That starts the 24 hour clock for deleting its body.
	const closeQuestion = db
		.prepare(
			`UPDATE messages
			SET status = ?1, received_at = COALESCE(received_at, ?2)
			WHERE id = ?3 AND status = 'pending'
				AND EXISTS (SELECT 1 FROM messages AS r WHERE r.id = ?4)`,
		)
		.bind(isAnswer ? "answered" : "declined", now, questionId, replyId);

	let stored: boolean;
	try {
		const [inserted] = await db.batch([insertReply, closeQuestion]);
		stored = inserted.meta.changes === 1;
	} catch (error) {
		if (!isUniqueViolation(error)) {
			throw error;
		}
		return { ok: false, reason: "already_replied" };
	}

	const question = await db
		.prepare("SELECT * FROM messages WHERE id = ? AND kind = 'question'")
		.bind(questionId)
		.first<MessageRow>();

	if (stored) {
		if (!question?.from_agent_id || !question.category_id) {
			throw new Error(`Question ${questionId} vanished after being answered`);
		}
		return {
			ok: true,
			replyId,
			askerAgentId: question.from_agent_id,
			categoryId: question.category_id,
		};
	}
	return { ok: false, reason: failureReason(question, responderAgentId, now) };
}

function failureReason(
	question: MessageRow | null,
	responderAgentId: string,
	now: UnixMillis,
): AnswerFailureReason {
	if (question === null || question.status === "blocked") {
		return "not_found";
	}
	if (question.to_agent_id !== responderAgentId) {
		return "not_recipient";
	}
	if (question.status === "answered" || question.status === "declined") {
		return "already_replied";
	}
	if (
		question.status === "expired" ||
		(question.expires_at !== null && question.expires_at <= now)
	) {
		return "expired";
	}
	throw new Error(`Question ${question.id} rejected a valid reply`);
}
