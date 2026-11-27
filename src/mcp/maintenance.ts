import { expireProposals } from "../adminbot/proposals";
import {
	purgeExpiredAuditBodies,
	purgeExpiredAuditLogs,
	recordAuditEvents,
} from "../audit";
import { purgeRevokedTokens } from "../auth";
import { purgeOldMessages, runInboxMaintenance } from "../inbox";
import {
	enqueueWake,
	processDueWebhooks,
	purgeFinishedWebhookDeliveries,
	type WebhookFetcher,
} from "../notify";
import type { UnixMillis } from "../types";
import {
	allowInsecureLocalhostWebhook,
	auditBodyConfig,
	auditLogRetentionDays,
	type McpEnv,
} from "./config";

export const WEBHOOK_POLL_CRON = "* * * * *";
export const HOURLY_MAINTENANCE_CRON = "0 * * * *";

export interface ScheduledMaintenanceOptions {
	webhookFetcher?: WebhookFetcher;
}

export interface MaintenanceResult {
	expiredQuestions: number;
	messageBodiesDeleted: number;
	messagesPurged: number;
	auditBodiesDeleted: number;
	auditLogsPurged: number;
	revokedTokensPurged: number;
	expiredProposals: number;
	webhooksProcessed: number;
	webhookDeliveriesPurged: number;
}

type MaintenanceStep =
	| "inbox"
	| "message_purge"
	| "audit_purge"
	| "audit_log_purge"
	| "token_purge"
	| "proposals"
	| "webhooks"
	| "webhook_purge";

function reportMaintenanceFailure(step: MaintenanceStep, error: unknown): void {
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
 * `audit_log`, `tokens`, or `proposals`.
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
 * The hourly scheduled job: expires overdue questions, deletes message bodies
 * past their retention, purges terminal message rows, removes audit log bodies
 * and rows past their retention, purges old revoked tokens, expires overdue
 * proposals, delivers due webhooks, and purges finished webhook delivery rows.
 * Each step is fault-isolated so a failure in one does not starve the others.
 */
export async function runScheduledMaintenance(
	env: McpEnv,
	now: UnixMillis,
	options?: ScheduledMaintenanceOptions,
): Promise<MaintenanceResult> {
	const db = env.DB;
	const audit = auditBodyConfig(env);
	const logRetentionDays = auditLogRetentionDays(env);
	const errors: unknown[] = [];
	const result: MaintenanceResult = {
		expiredQuestions: 0,
		messageBodiesDeleted: 0,
		messagesPurged: 0,
		auditBodiesDeleted: 0,
		auditLogsPurged: 0,
		revokedTokensPurged: 0,
		expiredProposals: 0,
		webhooksProcessed: 0,
		webhookDeliveriesPurged: 0,
	};

	try {
		const { expiredQuestions, bodiesDeleted } = await runInboxMaintenance(
			db,
			now,
		);
		result.expiredQuestions = expiredQuestions.length;
		result.messageBodiesDeleted = bodiesDeleted;
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
		result.messagesPurged = await purgeOldMessages(db, now);
	} catch (error) {
		reportMaintenanceFailure("message_purge", error);
		errors.push(error);
	}

	try {
		result.auditBodiesDeleted = await purgeExpiredAuditBodies(db, audit, now);
	} catch (error) {
		reportMaintenanceFailure("audit_purge", error);
		errors.push(error);
	}

	try {
		result.auditLogsPurged = await purgeExpiredAuditLogs(
			db,
			now,
			logRetentionDays,
		);
	} catch (error) {
		reportMaintenanceFailure("audit_log_purge", error);
		errors.push(error);
	}

	try {
		result.revokedTokensPurged = await purgeRevokedTokens(db, now);
	} catch (error) {
		reportMaintenanceFailure("token_purge", error);
		errors.push(error);
	}

	try {
		result.expiredProposals = await expireProposals(db, now);
	} catch (error) {
		reportMaintenanceFailure("proposals", error);
		errors.push(error);
	}

	try {
		const webhooks = await processDueWebhooks(db, {
			now,
			audit,
			allowInsecureLocalhost: allowInsecureLocalhostWebhook(env),
			fetcher: options?.webhookFetcher,
		});
		result.webhooksProcessed = webhooks.processed;
	} catch (error) {
		reportMaintenanceFailure("webhooks", error);
		errors.push(error);
	}

	try {
		result.webhookDeliveriesPurged = await purgeFinishedWebhookDeliveries(
			db,
			now,
		);
	} catch (error) {
		reportMaintenanceFailure("webhook_purge", error);
		errors.push(error);
	}

	if (errors.length === 1) {
		throw errors[0];
	}
	if (errors.length > 1) {
		throw new AggregateError(errors, "scheduled maintenance failed");
	}
	return result;
}
