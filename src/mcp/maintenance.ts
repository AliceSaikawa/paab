import { expireOverdueProposals } from "../adminbot";
import { purgeExpiredAuditBodies, recordAuditEvents } from "../audit";
import { runInboxMaintenance } from "../inbox";
import {
	enqueueWebhooksForAgents,
	isLocalWebhookAllowed,
	processDueWebhooks,
	purgeOldWebhookDeliveries,
} from "../notify";
import type { UnixMillis } from "../types";
import { auditBodyConfig, type McpEnv } from "./config";

function reportMaintenanceFailure(
	step: "inbox" | "audit_purge" | "proposals" | "webhooks",
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
 * log with one batched write per chunk, removes audit log bodies past their
 * retention, expires overdue admin bot proposals, delivers due webhooks, and
 * prunes old completed or abandoned webhook delivery records.
 * Each step runs in an isolated block so a failure in one does not starve the others.
 */
export async function runScheduledMaintenance(
	env: McpEnv,
	now: UnixMillis,
): Promise<void> {
	const db = env.DB;
	const audit = auditBodyConfig(env);
	const errors: unknown[] = [];
	let expiredAskerIds: string[] = [];

	try {
		const { expiredQuestions } = await runInboxMaintenance(db, now);
		expiredAskerIds = expiredQuestions.map((question) => question.fromAgentId);
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

	try {
		await expireOverdueProposals(db, now);
	} catch (error) {
		reportMaintenanceFailure("proposals", error);
		errors.push(error);
	}

	try {
		if (expiredAskerIds.length > 0) {
			await enqueueWebhooksForAgents(db, expiredAskerIds, now);
		}
		await processDueWebhooks(db, {
			now,
			audit,
			allowLocal: isLocalWebhookAllowed(env),
			fetcher: env.webhookFetcher,
		});
		await purgeOldWebhookDeliveries(db, now);
	} catch (error) {
		reportMaintenanceFailure("webhooks", error);
		errors.push(error);
	}

	if (errors.length === 1) {
		throw errors[0];
	}
	if (errors.length > 1) {
		throw new AggregateError(errors, "scheduled maintenance failed");
	}
}
