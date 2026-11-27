import { newId } from "../db";
import type { Message, UnixMillis } from "../types";

/**
 * Builds the rejection row for a question.
 *
 * Every rejection is stored the same way, whether the bridge blocked the
 * question, the recipient declined it or it expired (design 3.4): no sender,
 * no category and no body. Echoing the recipient or the category would
 * reveal whether the requested one exists. The reason lives in the question's
 * status and in the audit log, neither of which the asker can read.
 *
 * The SQL in `answer.ts` and `maintenance.ts` inserts the same shape.
 */
export function rejectionFor(input: {
	questionId: string;
	askerAgentId: string;
	now: UnixMillis;
	availableAt: UnixMillis | null;
}): Message {
	return {
		id: newId(),
		kind: "rejection",
		fromAgentId: null,
		toAgentId: input.askerAgentId,
		categoryId: null,
		body: null,
		inReplyTo: input.questionId,
		status: "sent",
		createdAt: input.now,
		receivedAt: null,
		expiresAt: null,
		bodyDeletedAt: null,
		availableAt: input.availableAt,
	};
}
