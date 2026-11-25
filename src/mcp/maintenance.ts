import { purgeExpiredAuditBodies, recordAuditEvents } from "../audit";
import { runInboxMaintenance } from "../inbox";
import type { UnixMillis } from "../types";
import { auditBodyConfig, type McpEnv } from "./config";

function reportMaintenanceFailure(
	step: "inbox" | "audit_purge",
	error: unknown,
): void {
	try {
		console.error("scheduled maintenance step failed", {
			step,
			error: error instanceof Error ? error.message : String(error),
		});
	} catch {
		// Logging failures must not hide the underlying step error.
	}
}

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
		reportMaintenanceFailure("inbox", error);
		errors.push(error);
	}

	try {
		await purgeExpiredAuditBodies(db, audit, now);
	} catch (error) {
		reportMaintenanceFailure("audit_purge", error);
		errors.push(error);
	}

	if (errors.length === 1) {
		throw errors[0];
	}
	if (errors.length > 1) {
		throw new AggregateError(errors, "scheduled maintenance failed");
	}
}
