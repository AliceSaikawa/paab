import { expireOverdueProposals } from "../adminbot";
import { purgeExpiredAuditBodies, recordAuditEvents } from "../audit";
import { runInboxMaintenance } from "../inbox";
import type { UnixMillis } from "../types";
import { auditBodyConfig, type McpEnv } from "./config";

/**
 * The scheduled job: expires overdue questions, records them in the audit
 * log with one batched write per chunk, removes audit log bodies past their
 * retention, and expires overdue admin bot proposals. Each step runs in an
 * isolated block so a failure in one does not starve the others.
 */
export async function runScheduledMaintenance(
	env: McpEnv,
	now: UnixMillis,
): Promise<void> {
	const db = env.DB;
	const audit = auditBodyConfig(env);
	const errors: unknown[] = [];

	try {
		const { expiredQuestions } = await runInboxMaintenance(db, now);
		await recordAuditEvents(
			db,
			audit,
			expiredQuestions.map((question) => ({
				eventType: "question_expired" as const,
				occurredAt: now,
				fromAgentId: question.fromAgentId,
				toAgentId: question.toAgentId,
				categoryId: question.categoryId,
				messageId: question.questionId,
			})),
		);
	} catch (error) {
		errors.push(error);
	}

	try {
		await purgeExpiredAuditBodies(db, audit, now);
	} catch (error) {
		errors.push(error);
	}

	try {
		await expireOverdueProposals(db, now);
	} catch (error) {
		errors.push(error);
	}

	if (errors.length === 1) {
		throw errors[0];
	}
	if (errors.length > 1) {
		throw new AggregateError(errors, "scheduled maintenance failed");
	}
}
