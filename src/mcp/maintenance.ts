import { purgeExpiredAuditBodies, recordAuditEvent } from "../audit";
import { runInboxMaintenance } from "../inbox";
import type { UnixMillis } from "../types";
import { auditBodyConfig, type McpEnv } from "./config";

/**
 * The scheduled job: expires overdue questions, records each in the audit
 * log, then removes audit log bodies past their retention.
 */
export async function runScheduledMaintenance(
	env: McpEnv,
	now: UnixMillis,
): Promise<void> {
	const db = env.DB;
	const audit = auditBodyConfig(env);
	const { expiredQuestions } = await runInboxMaintenance(db, now);
	for (const question of expiredQuestions) {
		await recordAuditEvent(db, audit, {
			eventType: "question_expired",
			occurredAt: now,
			fromAgentId: question.fromAgentId,
			toAgentId: question.toAgentId,
			categoryId: question.categoryId,
			messageId: question.questionId,
		});
	}
	await purgeExpiredAuditBodies(db, audit, now);
}
