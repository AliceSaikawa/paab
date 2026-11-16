import { insertMessage, newId } from "../db";
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

export interface SubmittedQuestion {
	questionId: string;
	expiresAt: UnixMillis;
}

/**
 * Stores a question the bridge accepted. The recipient gets it on its next
 * inbox fetch. Rule matching, limits and body validation are the caller's
 * job.
 */
export async function submitQuestion(
	db: D1Database,
	input: SubmitQuestionInput,
): Promise<SubmittedQuestion> {
	const questionId = newId();
	const expiresAt = input.now + QUESTION_TTL_MS;
	await insertMessage(db, {
		id: questionId,
		kind: "question",
		fromAgentId: input.fromAgentId,
		toAgentId: input.toAgentId,
		categoryId: input.categoryId,
		body: input.body,
		inReplyTo: null,
		status: "pending",
		createdAt: input.now,
		receivedAt: null,
		expiresAt,
		bodyDeletedAt: null,
	}).run();
	return { questionId, expiresAt };
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
