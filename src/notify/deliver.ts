import { type AuditBodyConfig, recordAuditEvent } from "../audit";
import {
	agentWebhookFromRow,
	newId,
	type WebhookDeliveryRow,
	webhookDeliveryFromRow,
} from "../db";
import type { AgentWebhook, UnixMillis, WebhookDelivery } from "../types";
import { buildWebhookHeaders, WAKE_PAYLOAD } from "./sign";
import { validateCustomHeaderName, validateWebhookUrl } from "./validate";

export const WEBHOOK_MAX_ATTEMPTS = 3;
export const WEBHOOK_RETRY_DELAYS_MS = [0, 60_000, 300_000] as const;
export const WEBHOOK_BLOCKED_DELAY_MS = 60_000;
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const DEFAULT_DUE_WEBHOOK_LIMIT = 8;
export const WEBHOOK_IN_FLIGHT_LEASE_MS = 10_000;
export const WEBHOOK_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const WEBHOOK_PURGE_CHUNK = 500;
const MAX_WEBHOOK_PURGE_CHUNKS = 5;
const MAX_ERROR_LENGTH = 200;

function stripControlChars(text: string): string {
	let out = "";
	let inControl = false;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) {
			if (!inControl) {
				out += " ";
				inControl = true;
			}
		} else {
			out += text[i];
			inControl = false;
		}
	}
	return out;
}

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
			reason: "not_pending" | "not_due" | "agent_suspended" | "no_webhook";
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

interface JoinedDueWebhookRow extends WebhookDeliveryRow {
	agent_status: string | null;
	webhook_agent_id: string | null;
	url: string | null;
	auth_mode: string | null;
	header_name: string | null;
	secret: string | null;
	webhook_created_at: number | null;
	webhook_updated_at: number | null;
}

function extractWebhookFromJoinedRow(
	row: JoinedDueWebhookRow,
): AgentWebhook | null {
	if (
		row.webhook_agent_id === null ||
		row.url === null ||
		row.auth_mode === null ||
		row.secret === null ||
		row.webhook_created_at === null ||
		row.webhook_updated_at === null
	) {
		return null;
	}
	return agentWebhookFromRow({
		agent_id: row.webhook_agent_id,
		url: row.url,
		auth_mode: row.auth_mode,
		header_name: row.header_name,
		secret: row.secret,
		created_at: row.webhook_created_at,
		updated_at: row.webhook_updated_at,
	});
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

	text = stripControlChars(text).trim();
	if (text.length === 0) {
		return "unknown webhook delivery error";
	}
	if (text.length > MAX_ERROR_LENGTH) {
		return text.slice(0, MAX_ERROR_LENGTH);
	}
	return text;
}

interface EnqueuedWakeRecord {
	id: string;
	attempts: number;
	nextAttemptAt: UnixMillis;
	leasedUntil: UnixMillis | null;
}

async function enqueueWakeRecord(
	db: D1Database,
	input: EnqueueWakeInput,
): Promise<EnqueuedWakeRecord | null> {
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
				(id, agent_id, status, attempts, next_attempt_at, leased_until, last_error, created_at, updated_at)
			VALUES (?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)
			ON CONFLICT (agent_id) WHERE status = 'pending' DO UPDATE SET
				next_attempt_at = CASE
					WHEN webhook_deliveries.attempts = 0
					THEN MIN(webhook_deliveries.next_attempt_at, excluded.next_attempt_at)
					ELSE webhook_deliveries.next_attempt_at
				END,
				updated_at = excluded.updated_at
			RETURNING id, attempts, next_attempt_at, leased_until`,
		)
		.bind(id, input.agentId, nextAttemptAt, input.now, input.now)
		.first<{
			id: string;
			attempts: number;
			next_attempt_at: number;
			leased_until: number | null;
		}>();

	return row === null
		? { id, attempts: 0, nextAttemptAt, leasedUntil: null }
		: {
				id: row.id,
				attempts: row.attempts,
				nextAttemptAt: row.next_attempt_at,
				leasedUntil: row.leased_until,
			};
}

/**
 * Enqueues a wake delivery for `agentId`, coalescing with any existing pending
 * delivery. Pulls `next_attempt_at` earlier only before the first attempt so
 * active retry backoff (60s / 300s) is never bypassed. Skips missing,
 * suspended, or unconfigured agents.
 */
export async function enqueueWake(
	db: D1Database,
	input: EnqueueWakeInput,
): Promise<string | null> {
	const record = await enqueueWakeRecord(db, input);
	return record?.id ?? null;
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
				SET status = 'abandoned', attempts = ?, leased_until = NULL, last_error = ?, updated_at = ?
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
			SET attempts = ?, next_attempt_at = ?, leased_until = NULL, last_error = ?, updated_at = ?
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

async function deliverLoadedWebhook(
	db: D1Database,
	delivery: WebhookDelivery,
	agentStatus: string | null,
	webhook: AgentWebhook | null,
	options: AttemptWebhookOptions,
): Promise<WebhookAttemptOutcome> {
	const {
		now,
		audit,
		fetcher = (input: string, init?: RequestInit) => fetch(input, init),
		allowInsecureLocalhost = false,
	} = options;

	if (
		delivery.nextAttemptAt > now ||
		(delivery.leasedUntil !== null && delivery.leasedUntil > now)
	) {
		return { status: "skipped", reason: "not_due" };
	}

	if (agentStatus !== "active" || webhook === null) {
		await db
			.prepare(
				"DELETE FROM webhook_deliveries WHERE id = ? AND status = 'pending'",
			)
			.bind(delivery.id)
			.run();
		return {
			status: "skipped",
			reason: agentStatus === "suspended" ? "agent_suspended" : "no_webhook",
		};
	}

	const lease = await db
		.prepare(
			`UPDATE webhook_deliveries
			SET leased_until = ?, updated_at = ?
			WHERE id = ?
				AND status = 'pending'
				AND attempts = ?
				AND next_attempt_at <= ?
				AND (leased_until IS NULL OR leased_until <= ?)`,
		)
		.bind(
			now + WEBHOOK_IN_FLIGHT_LEASE_MS,
			now,
			delivery.id,
			delivery.attempts,
			now,
			now,
		)
		.run();
	if ((lease.meta.changes ?? 0) === 0) {
		return { status: "skipped", reason: "not_due" };
	}

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
				SET status = 'delivered', attempts = ?, leased_until = NULL, last_error = NULL, updated_at = ?
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
 * Attempts one pending webhook delivery. Handles suspended-agent/missing-webhook
 * cleanup, SSRF re-validation, no-redirect 5s timeout POST, retries, and
 * audit logging.
 */
export async function attemptWebhookDelivery(
	db: D1Database,
	deliveryId: string,
	options: AttemptWebhookOptions,
): Promise<WebhookAttemptOutcome> {
	const raw = await db
		.prepare(
			`SELECT
				d.*,
				a.status AS agent_status,
				w.agent_id AS webhook_agent_id,
				w.url,
				w.auth_mode,
				w.header_name,
				w.secret,
				w.created_at AS webhook_created_at,
				w.updated_at AS webhook_updated_at
			FROM webhook_deliveries d
			LEFT JOIN agents a ON a.id = d.agent_id
			LEFT JOIN agent_webhooks w ON w.agent_id = d.agent_id
			WHERE d.id = ? AND d.status = 'pending'`,
		)
		.bind(deliveryId)
		.first<JoinedDueWebhookRow>();
	if (raw === null) {
		return { status: "skipped", reason: "not_pending" };
	}
	return deliverLoadedWebhook(
		db,
		webhookDeliveryFromRow(raw),
		raw.agent_status,
		extractWebhookFromJoinedRow(raw),
		options,
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
	const limit = options.limit ?? DEFAULT_DUE_WEBHOOK_LIMIT;
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
			`SELECT
				d.*,
				a.status AS agent_status,
				w.agent_id AS webhook_agent_id,
				w.url,
				w.auth_mode,
				w.header_name,
				w.secret,
				w.created_at AS webhook_created_at,
				w.updated_at AS webhook_updated_at
			FROM webhook_deliveries d
			JOIN agents a ON a.id = d.agent_id
			JOIN agent_webhooks w ON w.agent_id = d.agent_id
			WHERE d.status = 'pending'
				AND d.next_attempt_at <= ?
				AND (d.leased_until IS NULL OR d.leased_until <= ?)
			ORDER BY d.next_attempt_at ASC
			LIMIT ?`,
		)
		.bind(options.now, options.now, limit)
		.all<JoinedDueWebhookRow>();

	let delivered = 0;
	let retried = 0;
	let abandoned = 0;
	let skipped = 0;

	for (const row of results) {
		const outcome = await deliverLoadedWebhook(
			db,
			webhookDeliveryFromRow(row),
			row.agent_status,
			extractWebhookFromJoinedRow(row),
			{
				now: options.now,
				audit: options.audit,
				fetcher: options.fetcher,
				allowInsecureLocalhost: options.allowInsecureLocalhost,
			},
		);
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
		const record = await enqueueWakeRecord(db, {
			agentId: options.agentId,
			now: options.now,
			delayMs: 0,
		});
		if (
			record === null ||
			options.waitUntil === undefined ||
			record.attempts > 0 ||
			record.nextAttemptAt > options.now ||
			(record.leasedUntil !== null && record.leasedUntil > options.now)
		) {
			return;
		}
		options.waitUntil(
			attemptWebhookDelivery(db, record.id, {
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

/**
 * Deletes finished (`delivered` or `abandoned`) webhook delivery rows whose
 * `updated_at` is at or before `now - WEBHOOK_DELIVERY_RETENTION_MS`. Pending
 * rows are never touched.
 */
export async function purgeFinishedWebhookDeliveries(
	db: D1Database,
	now: UnixMillis,
): Promise<number> {
	const cutoff = now - WEBHOOK_DELIVERY_RETENTION_MS;
	const statement = db
		.prepare(
			`DELETE FROM webhook_deliveries
			WHERE id IN (
				SELECT id FROM webhook_deliveries
				WHERE status IN ('delivered', 'abandoned') AND updated_at <= ?1
				ORDER BY updated_at ASC
				LIMIT ?2
			)`,
		)
		.bind(cutoff, WEBHOOK_PURGE_CHUNK);
	let deleted = 0;
	for (let chunk = 0; chunk < MAX_WEBHOOK_PURGE_CHUNKS; chunk += 1) {
		const result = await statement.run();
		const changes = result.meta.changes ?? 0;
		deleted += changes;
		if (changes < WEBHOOK_PURGE_CHUNK) {
			break;
		}
	}
	return deleted;
}
