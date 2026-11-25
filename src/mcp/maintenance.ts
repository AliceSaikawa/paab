import { purgeExpiredAuditBodies, recordAuditEvents } from "../audit";
import { runInboxMaintenance } from "../inbox";
import type { UnixMillis } from "../types";
import { auditBodyConfig, type McpEnv } from "./config";

/**
 * The scheduled job: expires overdue questions, records them in the audit
 * log with one batched write per chunk, then removes audit log bodies past
 * their retention. Expiry and body removal are independent: a failure of
 * one does not skip the other, so a broken half is retried by the next run
 * instead of silently starving the other.
 */
export async function runScheduledMaintenance(
	env: McpEnv,
	now: UnixMillis,
): Promise<void> {
	const db = env.DB;
	const audit = auditBodyConfig(env);
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
	} finally {
		await purgeExpiredAuditBodies(db, audit, now);
	}
}
