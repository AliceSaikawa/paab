import { recordAuditEvent } from "../audit";
import { insertWebhookDelivery, newId } from "../db";
import type { UnixMillis } from "../types";
import { signWebhookPayload, WEBHOOK_BODY } from "./sign";
import type {
	EnqueueWebhookOptions,
	EnqueueWebhookResult,
	ProcessWebhooksResult,
	WebhookAttemptResult,
	WebhookDispatchOptions,
} from "./types";
import { validateWebhookUrl } from "./url";

export const MAX_WEBHOOK_ATTEMPTS = 3;
export const WEBHOOK_RETRY_DELAYS_MS = [0, 60_000, 300_000] as const;
export const WEBHOOK_BLOCKED_DELAY_MS = WEBHOOK_RETRY_DELAYS_MS[1];

const WEBHOOK_FETCH_TIMEOUT_MS = 5000;
const MAX_LAST_ERROR_LENGTH = 500;
const DELIVERY_CHUNK = 25;

interface PendingIdRow {
	id: string;
}

interface DeliveryJoinedRow {
	id: string;
	agent_id: string;
	status: string;
	attempts: number;
	next_attempt_at: number;
	last_error: string | null;
	created_at: number;
	updated_at: number;
	webhook_url: string | null;
	webhook_secret: string | null;
	agent_status: string;
}

function truncateError(raw: string): string {
	const cleaned = raw.replaceAll(/[\r\n]+/g, " ").trim();
	if (cleaned.length <= MAX_LAST_ERROR_LENGTH) {
		return cleaned;
	}
	return `${cleaned.slice(0, MAX_LAST_ERROR_LENGTH - 3)}...`;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message || error.name;
	}
	return String(error);
}

function formatHttpError(status: number, statusText: string): string {
	const suffix = statusText.trim();
	return suffix.length > 0 ? `HTTP ${status} ${suffix}` : `HTTP ${status}`;
}

function insertPendingForActiveConfiguredAgent(
	db: D1Database,
	agentId: string,
	nextAttemptAt: UnixMillis,
	now: UnixMillis,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO webhook_deliveries
				(id, agent_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
			SELECT ?1, a.id, 'pending', 0, ?2, NULL, ?3, ?3
			FROM agents a
			JOIN agent_webhooks w ON w.agent_id = a.id
			WHERE a.id = ?4
				AND a.status = 'active'
				AND NOT EXISTS (
					SELECT 1 FROM webhook_deliveries d
					WHERE d.agent_id = a.id AND d.status = 'pending'
				)`,
		)
		.bind(newId(), nextAttemptAt, now, agentId);
}

/**
 * Queues a coalesced wake-up delivery for an active agent with a configured
 * webhook. Reuses any existing `pending` delivery instead of duplicating rows.
 */
export async function enqueueWebhookDelivery(
	db: D1Database,
	options: EnqueueWebhookOptions,
): Promise<EnqueueWebhookResult> {
	const { agentId, now, immediate } = options;
	const selectPending = db
		.prepare(
			`SELECT id FROM webhook_deliveries
			WHERE agent_id = ? AND status = 'pending'
			ORDER BY created_at ASC, id ASC
			LIMIT 1`,
		)
		.bind(agentId);

	if (!immediate) {
		const [, selected] = await db.batch([
			insertPendingForActiveConfiguredAgent(
				db,
				agentId,
				now + WEBHOOK_BLOCKED_DELAY_MS,
				now,
			),
			selectPending,
		]);
		const row = (selected?.results[0] ?? null) as PendingIdRow | null;
		return { deliveryId: row?.id ?? null, shouldDispatchNow: false };
	}

	const pullForward = db
		.prepare(
			`UPDATE webhook_deliveries
			SET next_attempt_at = ?1, updated_at = ?1
			WHERE agent_id = ?2
				AND status = 'pending'
				AND attempts = 0
				AND next_attempt_at > ?1
				AND EXISTS (
					SELECT 1 FROM agents a
					JOIN agent_webhooks w ON w.agent_id = a.id
					WHERE a.id = ?2 AND a.status = 'active'
				)`,
		)
		.bind(now, agentId);

	const [pulled, inserted, selected] = await db.batch([
		pullForward,
		insertPendingForActiveConfiguredAgent(db, agentId, now, now),
		selectPending,
	]);
	const row = (selected?.results[0] ?? null) as PendingIdRow | null;
	const deliveryId = row?.id ?? null;
	const shouldDispatchNow =
		deliveryId !== null &&
		(pulled.meta.changes > 0 || inserted.meta.changes > 0);
	return { deliveryId, shouldDispatchNow };
}

/**
 * Queues coalesced immediate wake-ups for multiple agents (such as askers
 * whose questions expired during scheduled maintenance).
 */
export async function enqueueWebhooksForAgents(
	db: D1Database,
	agentIds: readonly string[],
	now: UnixMillis,
): Promise<number> {
	const uniqueIds = [...new Set(agentIds)];
	if (uniqueIds.length === 0) {
		return 0;
	}
	const idsJson = JSON.stringify(uniqueIds);

	const [, eligible] = await db.batch([
		db
			.prepare(
				`UPDATE webhook_deliveries
				SET next_attempt_at = ?1, updated_at = ?1
				WHERE status = 'pending'
					AND attempts = 0
					AND next_attempt_at > ?1
					AND agent_id IN (
						SELECT a.id FROM agents a
						JOIN agent_webhooks w ON w.agent_id = a.id
						WHERE a.status = 'active'
							AND a.id IN (SELECT value FROM json_each(?2))
					)`,
			)
			.bind(now, idsJson),
		db
			.prepare(
				`SELECT a.id AS agent_id
				FROM agents a
				JOIN agent_webhooks w ON w.agent_id = a.id
				WHERE a.status = 'active'
					AND a.id IN (SELECT value FROM json_each(?1))
					AND NOT EXISTS (
						SELECT 1 FROM webhook_deliveries d
						WHERE d.agent_id = a.id AND d.status = 'pending'
					)`,
			)
			.bind(idsJson),
	]);

	const toInsert = (eligible?.results ?? []) as Array<{ agent_id: string }>;
	if (toInsert.length === 0) {
		return 0;
	}

	const statements = toInsert.map((row) =>
		insertWebhookDelivery(db, {
			id: newId(),
			agentId: row.agent_id,
			status: "pending",
			attempts: 0,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}),
	);
	for (let i = 0; i < statements.length; i += DELIVERY_CHUNK) {
		await db.batch(statements.slice(i, i + DELIVERY_CHUNK));
	}
	return toInsert.length;
}

async function markDelivered(
	db: D1Database,
	row: DeliveryJoinedRow,
	options: WebhookDispatchOptions,
): Promise<WebhookAttemptResult> {
	const nextAttempts = row.attempts + 1;
	const result = await db
		.prepare(
			`UPDATE webhook_deliveries
			SET status = 'delivered', attempts = ?1, last_error = NULL, updated_at = ?2
			WHERE id = ?3 AND status = 'pending' AND attempts = ?4`,
		)
		.bind(nextAttempts, options.now, row.id, row.attempts)
		.run();
	if (result.meta.changes === 1) {
		await recordAuditEvent(db, options.audit, {
			eventType: "webhook_notified",
			occurredAt: options.now,
			toAgentId: row.agent_id,
		});
	}
	return {
		deliveryId: row.id,
		agentId: row.agent_id,
		status: "delivered",
		attempts: nextAttempts,
		lastError: null,
	};
}

async function markFailed(
	db: D1Database,
	row: DeliveryJoinedRow,
	rawError: string,
	options: WebhookDispatchOptions,
): Promise<WebhookAttemptResult> {
	const nextAttempts = row.attempts + 1;
	const lastError = truncateError(rawError);

	if (nextAttempts >= MAX_WEBHOOK_ATTEMPTS) {
		const result = await db
			.prepare(
				`UPDATE webhook_deliveries
				SET status = 'abandoned', attempts = ?1, last_error = ?2, updated_at = ?3
				WHERE id = ?4 AND status = 'pending' AND attempts = ?5`,
			)
			.bind(nextAttempts, lastError, options.now, row.id, row.attempts)
			.run();
		if (result.meta.changes === 1) {
			await recordAuditEvent(db, options.audit, {
				eventType: "webhook_failed",
				occurredAt: options.now,
				toAgentId: row.agent_id,
				reasonCode: "webhook_delivery_failed",
			});
		}
		return {
			deliveryId: row.id,
			agentId: row.agent_id,
			status: "abandoned",
			attempts: nextAttempts,
			lastError,
		};
	}

	const delay =
		WEBHOOK_RETRY_DELAYS_MS[nextAttempts] ??
		WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.length - 1];
	const nextAttemptAt = options.now + delay;
	await db
		.prepare(
			`UPDATE webhook_deliveries
			SET attempts = ?1, next_attempt_at = ?2, last_error = ?3, updated_at = ?4
			WHERE id = ?5 AND status = 'pending' AND attempts = ?6`,
		)
		.bind(
			nextAttempts,
			nextAttemptAt,
			lastError,
			options.now,
			row.id,
			row.attempts,
		)
		.run();
	return {
		deliveryId: row.id,
		agentId: row.agent_id,
		status: "pending",
		attempts: nextAttempts,
		lastError,
	};
}

async function abandonUnconfiguredOrSuspended(
	db: D1Database,
	row: DeliveryJoinedRow,
	now: UnixMillis,
): Promise<WebhookAttemptResult> {
	const reason =
		row.agent_status !== "active" ? "agent suspended" : "webhook deleted";
	await db
		.prepare(
			`UPDATE webhook_deliveries
			SET status = 'abandoned', last_error = ?1, updated_at = ?2
			WHERE id = ?3 AND status = 'pending' AND attempts = ?4`,
		)
		.bind(reason, now, row.id, row.attempts)
		.run();
	return {
		deliveryId: row.id,
		agentId: row.agent_id,
		status: "abandoned",
		attempts: row.attempts,
		lastError: reason,
	};
}

async function executeAttempt(
	db: D1Database,
	row: DeliveryJoinedRow,
	options: WebhookDispatchOptions,
): Promise<WebhookAttemptResult> {
	if (
		row.agent_status !== "active" ||
		row.webhook_url === null ||
		row.webhook_secret === null
	) {
		return abandonUnconfiguredOrSuspended(db, row, options.now);
	}

	const urlCheck = validateWebhookUrl(row.webhook_url, options.allowLocal);
	if (!urlCheck.ok) {
		return markFailed(db, row, urlCheck.message, options);
	}

	const timestampSeconds = String(Math.floor(options.now / 1000));
	const signature = await signWebhookPayload(
		row.webhook_secret,
		timestampSeconds,
		WEBHOOK_BODY,
	);
	const fetcher = options.fetcher ?? fetch;

	try {
		const response = await fetcher(urlCheck.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Paab-Timestamp": timestampSeconds,
				"X-Paab-Signature": signature,
			},
			body: WEBHOOK_BODY,
			// workerd rejects redirect: "error" at runtime; manual mode blocks SSRF redirects cleanly.
			redirect: "manual",
			signal: AbortSignal.timeout(WEBHOOK_FETCH_TIMEOUT_MS),
		});
		try {
			await response.body?.cancel();
		} catch {
			// Ignore stream cancel errors after capturing HTTP status.
		}
		if (response.ok) {
			return markDelivered(db, row, options);
		}
		const failureReason =
			response.status >= 300 && response.status < 400
				? `redirect rejected (${formatHttpError(response.status, response.statusText)})`
				: formatHttpError(response.status, response.statusText);
		return markFailed(db, row, failureReason, options);
	} catch (error) {
		return markFailed(db, row, formatError(error), options);
	}
}

/** Dispatches a single pending delivery if it exists and is due at `options.now`. */
export async function dispatchWebhookDelivery(
	db: D1Database,
	deliveryId: string,
	options: WebhookDispatchOptions,
): Promise<WebhookAttemptResult | null> {
	const row = await db
		.prepare(
			`SELECT d.*, w.url AS webhook_url, w.signing_secret AS webhook_secret, a.status AS agent_status
			FROM webhook_deliveries d
			JOIN agents a ON a.id = d.agent_id
			LEFT JOIN agent_webhooks w ON w.agent_id = d.agent_id
			WHERE d.id = ?`,
		)
		.bind(deliveryId)
		.first<DeliveryJoinedRow>();
	if (row === null) {
		return null;
	}
	if (row.status !== "pending" || row.next_attempt_at > options.now) {
		return {
			deliveryId: row.id,
			agentId: row.agent_id,
			status: "skipped",
			attempts: row.attempts,
			lastError: row.last_error,
		};
	}
	return executeAttempt(db, row, options);
}

/**
 * Enqueues a wake-up delivery for `agentId` and dispatches attempt 1 when due.
 * Uses `executionCtx.waitUntil` when available so callers stay fast and keep
 * timing symmetric with blocked questions.
 */
export async function wakeAgentWithWebhook(
	db: D1Database,
	input: EnqueueWebhookOptions &
		WebhookDispatchOptions & {
			executionCtx?: Pick<ExecutionContext, "waitUntil">;
		},
): Promise<void> {
	const queued = await enqueueWebhookDelivery(db, {
		agentId: input.agentId,
		now: input.now,
		immediate: input.immediate,
	});
	if (!queued.shouldDispatchNow || queued.deliveryId === null) {
		return;
	}
	const deliveryPromise = dispatchWebhookDelivery(db, queued.deliveryId, {
		now: input.now,
		audit: input.audit,
		allowLocal: input.allowLocal,
		fetcher: input.fetcher,
	}).catch((error) => {
		console.error("webhook dispatch failed", {
			agentId: input.agentId,
			deliveryId: queued.deliveryId,
			error: formatError(error),
		});
	});
	if (input.executionCtx !== undefined) {
		input.executionCtx.waitUntil(deliveryPromise);
	} else {
		await deliveryPromise;
	}
}

/** Processes all `pending` webhook deliveries whose `next_attempt_at <= now`. */
export async function processDueWebhooks(
	db: D1Database,
	options: WebhookDispatchOptions,
): Promise<ProcessWebhooksResult> {
	const summary: ProcessWebhooksResult = {
		processed: 0,
		delivered: 0,
		retried: 0,
		abandoned: 0,
	};
	const seenIds = new Set<string>();

	for (;;) {
		const { results } = await db
			.prepare(
				`SELECT d.*, w.url AS webhook_url, w.signing_secret AS webhook_secret, a.status AS agent_status
				FROM webhook_deliveries d
				JOIN agents a ON a.id = d.agent_id
				LEFT JOIN agent_webhooks w ON w.agent_id = d.agent_id
				WHERE d.status = 'pending' AND d.next_attempt_at <= ?
				ORDER BY d.next_attempt_at ASC, d.created_at ASC, d.id ASC
				LIMIT ?`,
			)
			.bind(options.now, DELIVERY_CHUNK)
			.all<DeliveryJoinedRow>();

		const batch = results.filter((row) => !seenIds.has(row.id));
		if (batch.length === 0) {
			return summary;
		}
		for (const row of batch) {
			seenIds.add(row.id);
			const attempt = await executeAttempt(db, row, options);
			summary.processed += 1;
			if (attempt.status === "delivered") {
				summary.delivered += 1;
			} else if (attempt.status === "pending") {
				summary.retried += 1;
			} else if (attempt.status === "abandoned") {
				summary.abandoned += 1;
			}
		}
	}
}
