import { expireProposals } from "../adminbot/proposals";
import { purgeExpiredAuditBodies, recordAuditEvents } from "../audit";
import { runInboxMaintenance } from "../inbox";
import {
	enqueueWake,
	processDueWebhooks,
	type WebhookFetcher,
} from "../notify";
import type { UnixMillis } from "../types";
import {
	allowInsecureLocalhostWebhook,
	auditBodyConfig,
	type McpEnv,
} from "./config";

export const WEBHOOK_POLL_CRON = "* * * * *";
export const HOURLY_MAINTENANCE_CRON = "0 * * * *";

export interface ScheduledMaintenanceOptions {
	webhookFetcher?: WebhookFetcher;
}

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
 * The per-minute cron job: processes due webhook deliveries and purges pending
 * deliveries for suspended or unconfigured agents without querying `messages`,
 * `audit_log`, or `proposals`.
 */
export async function runWebhookMaintenance(
	env: McpEnv,
	now: UnixMillis,
	options?: ScheduledMaintenanceOptions,
): Promise<void> {
	try {
		await processDueWebhooks(env.DB, {
			now,
			audit: auditBodyConfig(env),
			allowInsecureLocalhost: allowInsecureLocalhostWebhook(env),
			fetcher: options?.webhookFetcher,
		});
	} catch (error) {
		reportMaintenanceFailure("webhooks", error);
		throw error;
	}
}

/**
 * The scheduled job: expires overdue questions, records them in the audit
 * log with one batched write per chunk, enqueues wakes for expired-question
 * askers, removes audit log bodies past their retention, expires overdue
 * proposals, and delivers due webhooks. Each step is fault-isolated so a
 * failure in one does not starve the others.
 */
export async function runScheduledMaintenance(
	env: McpEnv,
	now: UnixMillis,
	options?: ScheduledMaintenanceOptions,
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
		const expiredAskerIds = new Set(
			expiredQuestions.map((question) => question.fromAgentId),
		);
		for (const agentId of expiredAskerIds) {
			try {
				await enqueueWake(db, { agentId, now, delayMs: 0 });
			} catch (error) {
				reportMaintenanceFailure("webhooks", error);
			}
		}
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
		await expireProposals(db, now);
	} catch (error) {
		reportMaintenanceFailure("proposals", error);
		errors.push(error);
	}

	try {
		await processDueWebhooks(db, {
			now,
			audit,
			allowInsecureLocalhost: allowInsecureLocalhostWebhook(env),
			fetcher: options?.webhookFetcher,
		});
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
