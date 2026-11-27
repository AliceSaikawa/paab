import { type AuditBodyConfig, recordAuditEvent } from "../audit";
import {
	type AgentWebhookRow,
	agentWebhookFromRow,
	newId,
	type WebhookDeliveryRow,
	webhookDeliveryFromRow,
} from "../db";
import type { AgentWebhook, UnixMillis } from "../types";
import { buildWebhookHeaders, WAKE_PAYLOAD } from "./sign";
import { validateCustomHeaderName, validateWebhookUrl } from "./validate";

export const WEBHOOK_MAX_ATTEMPTS = 3;
export const WEBHOOK_RETRY_DELAYS_MS = [0, 60_000, 300_000] as const;
export const WEBHOOK_BLOCKED_DELAY_MS = 60_000;
export const WEBHOOK_TIMEOUT_MS = 5_000;

const MAX_ERROR_LENGTH = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from stored error messages.
const ERROR_CONTROL_CHARS = /[\x00-\x1f\x7f]+/g;

export type WebhookFetcher = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export interface EnqueueWakeInput {
	agentId: string;
	now: UnixMillis;
	delayMs?: number;
}

export interface AttemptWebhookOptions {
	now: UnixMillis;
	audit: AuditBodyConfig;
	fetcher?: WebhookFetcher;
	allowInsecureLocalhost?: boolean;
}

export type WebhookAttemptOutcome =
	| {
			status: "skipped";
			reason: "not_pending" | "agent_suspended" | "no_webhook";
	  }
	| { status: "delivered"; attempts: number }
	| {
			status: "retry_scheduled";
			attempts: number;
			nextAttemptAt: UnixMillis;
			error: string;
	  }
	| { status: "abandoned"; attempts: number; error: string };

export interface ProcessDueWebhooksOptions {
	now: UnixMillis;
	audit: AuditBodyConfig;
	fetcher?: WebhookFetcher;
	allowInsecureLocalhost?: boolean;
	limit?: number;
}

export interface ProcessDueWebhooksResult {
	purged: number;
	processed: number;
	delivered: number;
	retried: number;
	abandoned: number;
	skipped: number;
}

export interface NotifyAgentImmediatelyOptions {
	agentId: string;
	now: UnixMillis;
	audit: AuditBodyConfig;
	waitUntil?: (promise: Promise<unknown>) => void;
	fetcher?: WebhookFetcher;
	allowInsecureLocalhost?: boolean;
}

export interface ScheduleDelayedWakeOptions {
	agentId: string;
	now: UnixMillis;
	delayMs?: number;
}

interface AgentWebhookJoinRow extends Partial<AgentWebhookRow> {
	agent_status: string;
}

/**
 * Redacts the webhook secret (and raw key substrings) and truncates error text
 * before persisting `last_error` or logging.
 */
export function sanitizeWebhookError(
	error: unknown,
	webhook: Pick<AgentWebhook, "authMode" | "secret">,
): string {
	let text = error instanceof Error ? error.message : String(error);
	const secretsToRedact: string[] = [];
	if (webhook.secret.length > 0) {
		secretsToRedact.push(webhook.secret);
		const encoded = encodeURIComponent(webhook.secret);
		if (encoded !== webhook.secret) {
			secretsToRedact.push(encoded);
		}
		if (
			webhook.authMode === "standard_webhooks" &&
			webhook.secret.startsWith("whsec_")
		) {
			const rawKey = webhook.secret.slice("whsec_".length);
			if (rawKey.length > 0) {
				secretsToRedact.push(rawKey);
			}
		} else if (
			webhook.authMode === "paab_hmac" &&
			webhook.secret.startsWith("paab_whsec_")
		) {
			const rawKey = webhook.secret.slice("paab_whsec_".length);
			if (rawKey.length > 0) {
				secretsToRedact.push(rawKey);
			}
		}
	}

	for (const secretPart of secretsToRedact) {
		text = text.split(secretPart).join("[redacted]");
	}

	text = text.replace(ERROR_CONTROL_CHARS, " ").trim();
	if (text.length === 0) {
		return "unknown webhook delivery error";
	}
	if (text.length > MAX_ERROR_LENGTH) {
		return text.slice(0, MAX_ERROR_LENGTH);
	}
	return text;
}

/**
 * Enqueues a wake delivery for `agentId`, coalescing with any existing pending
 * delivery by taking the earlier `next_attempt_at`. Skips missing, suspended,
 * or unconfigured agents.
 */
export async function enqueueWake(
	db: D1Database,
	input: EnqueueWakeInput,
): Promise<string | null> {
	const delayMs = input.delayMs ?? 0;
	if (!Number.isSafeInteger(input.now)) {
		throw new Error("now must be an integer of UNIX milliseconds");
	}
	if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
		throw new Error("delayMs must be a non-negative integer");
	}

	const eligible = await db
		.prepare(
			`SELECT a.status
			FROM agents a
			JOIN agent_webhooks w ON w.agent_id = a.id
			WHERE a.id = ?`,
		)
		.bind(input.agentId)
		.first<{ status: string }>();

	if (eligible === null || eligible.status !== "active") {
		return null;
	}

	const id = newId();
	const nextAttemptAt = input.now + delayMs;
	const row = await db
		.prepare(
			`INSERT INTO webhook_deliveries
				(id, agent_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
			VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?)
			ON CONFLICT (agent_id) WHERE status = 'pending' DO UPDATE SET
				next_attempt_at = MIN(webhook_deliveries.next_attempt_at, excluded.next_attempt_at),
				updated_at = excluded.updated_at
			RETURNING id`,
		)
		.bind(id, input.agentId, nextAttemptAt, input.now, input.now)
		.first<{ id: string }>();

	return row?.id ?? id;
}

async function recordDeliveryFailure(
	db: D1Database,
	delivery: { id: string; agentId: string; attempts: number },
	webhook: AgentWebhook,
	rawError: unknown,
	now: UnixMillis,
	audit: AuditBodyConfig,
): Promise<WebhookAttemptOutcome> {
	const lastError = sanitizeWebhookError(rawError, webhook);
	const nextAttempts = delivery.attempts + 1;

	if (nextAttempts >= WEBHOOK_MAX_ATTEMPTS) {
		const update = await db
			.prepare(
				`UPDATE webhook_deliveries
				SET status = 'abandoned', attempts = ?, last_error = ?, updated_at = ?
				WHERE id = ? AND status = 'pending' AND attempts = ?`,
			)
			.bind(nextAttempts, lastError, now, delivery.id, delivery.attempts)
			.run();
		if ((update.meta.changes ?? 0) === 0) {
			return { status: "skipped", reason: "not_pending" };
		}
		await recordAuditEvent(db, audit, {
			eventType: "webhook_abandoned",
			occurredAt: now,
			toAgentId: delivery.agentId,
			reasonCode: "webhook_delivery_failed",
		});
		return { status: "abandoned", attempts: nextAttempts, error: lastError };
	}

	const retryDelay =
		WEBHOOK_RETRY_DELAYS_MS[nextAttempts] ??
		WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.length - 1];
	const nextAttemptAt = now + retryDelay;
	const update = await db
		.prepare(
			`UPDATE webhook_deliveries
			SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
			WHERE id = ? AND status = 'pending' AND attempts = ?`,
		)
		.bind(
			nextAttempts,
			nextAttemptAt,
			lastError,
			now,
			delivery.id,
			delivery.attempts,
		)
		.run();
	if ((update.meta.changes ?? 0) === 0) {
		return { status: "skipped", reason: "not_pending" };
	}
	return {
		status: "retry_scheduled",
		attempts: nextAttempts,
		nextAttemptAt,
		error: lastError,
	};
}

/**
 * Attempts one pending webhook delivery. Handles suspended-agent/missing-webhook
 * cleanup, SSRF re-validation, no-redirect 5s timeout POST, retries, and
 * audit logging.
 */
export async function attemptWebhookDelivery(
	db: D1Database,
	deliveryId: string,
	options: AttemptWebhookOptions,
): Promise<WebhookAttemptOutcome> {
	const {
		now,
		audit,
		fetcher = fetch as WebhookFetcher,
		allowInsecureLocalhost = false,
	} = options;

	const rawDelivery = await db
		.prepare(
			"SELECT * FROM webhook_deliveries WHERE id = ? AND status = 'pending'",
		)
		.bind(deliveryId)
		.first<WebhookDeliveryRow>();
	if (rawDelivery === null) {
		return { status: "skipped", reason: "not_pending" };
	}
	const delivery = webhookDeliveryFromRow(rawDelivery);

	const joined = await db
		.prepare(
			`SELECT
				a.status AS agent_status,
				w.agent_id,
				w.url,
				w.auth_mode,
				w.header_name,
				w.secret,
				w.created_at,
				w.updated_at
			FROM agents a
			LEFT JOIN agent_webhooks w ON w.agent_id = a.id
			WHERE a.id = ?`,
		)
		.bind(delivery.agentId)
		.first<AgentWebhookJoinRow>();

	if (
		joined === null ||
		joined.agent_status !== "active" ||
		joined.agent_id === undefined ||
		joined.agent_id === null ||
		joined.url === undefined ||
		joined.auth_mode === undefined ||
		joined.secret === undefined ||
		joined.created_at === undefined ||
		joined.updated_at === undefined
	) {
		await db
			.prepare(
				"DELETE FROM webhook_deliveries WHERE id = ? AND status = 'pending'",
			)
			.bind(delivery.id)
			.run();
		return {
			status: "skipped",
			reason:
				joined !== null && joined.agent_status === "suspended"
					? "agent_suspended"
					: "no_webhook",
		};
	}

	const webhook = agentWebhookFromRow({
		agent_id: joined.agent_id,
		url: joined.url,
		auth_mode: joined.auth_mode,
		header_name: joined.header_name ?? null,
		secret: joined.secret,
		created_at: joined.created_at,
		updated_at: joined.updated_at,
	});

	const urlCheck = validateWebhookUrl(webhook.url, { allowInsecureLocalhost });
	if (!urlCheck.ok) {
		return recordDeliveryFailure(
			db,
			delivery,
			webhook,
			new Error(`Blocked webhook URL: ${urlCheck.message}`),
			now,
			audit,
		);
	}

	if (webhook.authMode === "custom_header") {
		const headerCheck = validateCustomHeaderName(webhook.headerName);
		if (!headerCheck.ok) {
			return recordDeliveryFailure(
				db,
				delivery,
				webhook,
				new Error(`Blocked webhook header: ${headerCheck.message}`),
				now,
				audit,
			);
		}
	}

	let headers: Headers;
	try {
		headers = await buildWebhookHeaders(
			webhook,
			delivery.id,
			now,
			WAKE_PAYLOAD,
		);
	} catch (error) {
		return recordDeliveryFailure(db, delivery, webhook, error, now, audit);
	}

	let response: Response;
	try {
		response = await fetcher(urlCheck.url, {
			method: "POST",
			headers,
			body: WAKE_PAYLOAD,
			redirect: "manual",
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		});
	} catch (error) {
		return recordDeliveryFailure(db, delivery, webhook, error, now, audit);
	}

	try {
		await response.body?.cancel();
	} catch {
		// Ignore response cancellation errors after status inspection.
	}

	if (response.status >= 200 && response.status < 300) {
		const nextAttempts = delivery.attempts + 1;
		const update = await db
			.prepare(
				`UPDATE webhook_deliveries
				SET status = 'delivered', attempts = ?, last_error = NULL, updated_at = ?
				WHERE id = ? AND status = 'pending' AND attempts = ?`,
			)
			.bind(nextAttempts, now, delivery.id, delivery.attempts)
			.run();
		if ((update.meta.changes ?? 0) === 0) {
			return { status: "skipped", reason: "not_pending" };
		}
		await recordAuditEvent(db, audit, {
			eventType: "webhook_delivered",
			occurredAt: now,
			toAgentId: delivery.agentId,
		});
		return { status: "delivered", attempts: nextAttempts };
	}

	const statusError =
		response.status >= 300 && response.status < 400
			? `HTTP ${response.status} redirect rejected`
			: `HTTP ${response.status}`;
	return recordDeliveryFailure(
		db,
		delivery,
		webhook,
		new Error(statusError),
		now,
		audit,
	);
}

/**
 * Purges pending deliveries for suspended or unconfigured agents, then
 * processes up to `limit` due pending deliveries.
 */
export async function processDueWebhooks(
	db: D1Database,
	options: ProcessDueWebhooksOptions,
): Promise<ProcessDueWebhooksResult> {
	const limit = options.limit ?? 20;
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new Error("limit must be a positive integer");
	}

	const purge = await db
		.prepare(
			`DELETE FROM webhook_deliveries
			WHERE status = 'pending'
				AND (
					agent_id IN (SELECT id FROM agents WHERE status = 'suspended')
					OR agent_id NOT IN (SELECT agent_id FROM agent_webhooks)
				)`,
		)
		.run();
	const purged = purge.meta.changes ?? 0;

	const { results } = await db
		.prepare(
			`SELECT id FROM webhook_deliveries
			WHERE status = 'pending' AND next_attempt_at <= ?
			ORDER BY next_attempt_at ASC
			LIMIT ?`,
		)
		.bind(options.now, limit)
		.all<{ id: string }>();

	let delivered = 0;
	let retried = 0;
	let abandoned = 0;
	let skipped = 0;

	for (const row of results) {
		const outcome = await attemptWebhookDelivery(db, row.id, {
			now: options.now,
			audit: options.audit,
			fetcher: options.fetcher,
			allowInsecureLocalhost: options.allowInsecureLocalhost,
		});
		switch (outcome.status) {
			case "delivered":
				delivered += 1;
				break;
			case "retry_scheduled":
				retried += 1;
				break;
			case "abandoned":
				abandoned += 1;
				break;
			case "skipped":
				skipped += 1;
				break;
		}
	}

	return {
		purged,
		processed: results.length,
		delivered,
		retried,
		abandoned,
		skipped,
	};
}

/**
 * Enqueues an immediate wake and, when `waitUntil` is available, fires the
 * first HTTP attempt in the background without delaying or throwing to the
 * caller.
 */
export async function notifyAgentImmediately(
	db: D1Database,
	options: NotifyAgentImmediatelyOptions,
): Promise<void> {
	try {
		const deliveryId = await enqueueWake(db, {
			agentId: options.agentId,
			now: options.now,
			delayMs: 0,
		});
		if (deliveryId === null || options.waitUntil === undefined) {
			return;
		}
		options.waitUntil(
			attemptWebhookDelivery(db, deliveryId, {
				now: options.now,
				audit: options.audit,
				fetcher: options.fetcher,
				allowInsecureLocalhost: options.allowInsecureLocalhost,
			}).catch((error) => {
				try {
					console.error("immediate webhook delivery failed", {
						agentId: options.agentId,
						error: error instanceof Error ? error.message : String(error),
					});
				} catch {
					// Ignore logging errors.
				}
			}),
		);
	} catch (error) {
		try {
			console.error("failed to enqueue immediate webhook wake", {
				agentId: options.agentId,
				error: error instanceof Error ? error.message : String(error),
			});
		} catch {
			// Never throw to the caller.
		}
	}
}

/**
 * Enqueues a delayed wake (default 60s for blocked questions per design 3.4)
 * without making an immediate HTTP attempt. Never throws to the caller.
 */
export async function scheduleDelayedWake(
	db: D1Database,
	options: ScheduleDelayedWakeOptions,
): Promise<void> {
	try {
		await enqueueWake(db, {
			agentId: options.agentId,
			now: options.now,
			delayMs: options.delayMs ?? WEBHOOK_BLOCKED_DELAY_MS,
		});
	} catch (error) {
		try {
			console.error("failed to schedule delayed webhook wake", {
				agentId: options.agentId,
				error: error instanceof Error ? error.message : String(error),
			});
		} catch {
			// Never throw to the caller.
		}
	}
}
