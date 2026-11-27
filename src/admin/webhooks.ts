import {
	type AgentWebhookRow,
	agentWebhookFromRow,
	oneOf,
	upsertAgentWebhook,
	type WebhookDeliveryRow,
	webhookDeliveryFromRow,
} from "../db";
import {
	generatePaabWebhookSecret,
	validateCustomHeaderName,
	validateExternalSecret,
	validateStandardWebhooksSecret,
	validateWebhookUrl,
} from "../notify";
import {
	type AgentWebhook,
	type UnixMillis,
	WEBHOOK_AUTH_MODES,
	type WebhookAuthMode,
	type WebhookDeliveryStatus,
} from "../types";
import type { AdminResult, ChangeActor } from "./types";
import {
	fail,
	runWithChangeLog,
	validateContext,
	validateId,
} from "./validate";

export interface WebhookDeliverySummary {
	status: WebhookDeliveryStatus;
	attempts: number;
	nextAttemptAt: UnixMillis;
	lastError: string | null;
	updatedAt: UnixMillis;
}

export interface AgentWebhookSummary {
	agentId: string;
	url: string;
	authMode: WebhookAuthMode;
	headerName: string | null;
	createdAt: UnixMillis;
	updatedAt: UnixMillis;
	latestDelivery: WebhookDeliverySummary | null;
}

export interface WebhookAuditSnapshot {
	url: string;
	authMode: WebhookAuthMode;
	headerName: string | null;
}

export interface ConfigureAgentWebhookInput {
	agentId: string;
	url: string;
	authMode: WebhookAuthMode;
	headerName?: string | null;
	secret?: string | null;
	actor: ChangeActor;
	now: UnixMillis;
	allowInsecureLocalhost?: boolean;
}

export interface ConfiguredAgentWebhook {
	webhook: AgentWebhookSummary;
	/** Non-null only when `paab_hmac` generated a new secret (creation or mode switch). */
	revealedSecret: string | null;
	created: boolean;
}

export interface RotateAgentWebhookSecretInput {
	agentId: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface RotatedAgentWebhookSecret {
	webhook: AgentWebhookSummary;
	/** Newly generated `paab_whsec_` secret shown once to the owner. */
	revealedSecret: string;
}

export interface DeleteAgentWebhookInput {
	agentId: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface DeletedAgentWebhook {
	deleted: WebhookAuditSnapshot;
}

interface AgentWebhookSummaryRow {
	agent_id: string;
	url: string;
	auth_mode: string;
	header_name: string | null;
	created_at: number;
	updated_at: number;
}

function toAuditSnapshot(webhook: AgentWebhook): WebhookAuditSnapshot {
	return {
		url: webhook.url,
		authMode: webhook.authMode,
		headerName:
			webhook.authMode === "custom_header" ? webhook.headerName : null,
	};
}

function summaryFromRow(
	row: AgentWebhookSummaryRow,
	latestDelivery: WebhookDeliverySummary | null,
): AgentWebhookSummary {
	const authMode = oneOf(
		WEBHOOK_AUTH_MODES,
		row.auth_mode,
		"agent_webhooks.auth_mode",
	);
	if (authMode === "custom_header") {
		if (row.header_name === null || row.header_name.trim().length === 0) {
			throw new Error(
				"agent_webhooks.header_name is required for custom_header",
			);
		}
	} else if (row.header_name !== null) {
		throw new Error(
			`agent_webhooks.header_name must be null for auth_mode ${authMode}`,
		);
	}
	return {
		agentId: row.agent_id,
		url: row.url,
		authMode,
		headerName: authMode === "custom_header" ? row.header_name : null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		latestDelivery,
	};
}

function deliverySummaryFromRow(
	row: WebhookDeliveryRow,
): WebhookDeliverySummary {
	const delivery = webhookDeliveryFromRow(row);
	return {
		status: delivery.status,
		attempts: delivery.attempts,
		nextAttemptAt: delivery.nextAttemptAt,
		lastError: delivery.lastError,
		updatedAt: delivery.updatedAt,
	};
}

/**
 * Lists configured webhooks for all agents with their latest delivery status.
 * Never reads or returns `secret`.
 */
export async function listAgentWebhooks(
	db: D1Database,
): Promise<AgentWebhookSummary[]> {
	const [webhooksRes, deliveriesRes] = await db.batch([
		db.prepare(
			`SELECT agent_id, url, auth_mode, header_name, created_at, updated_at
			FROM agent_webhooks
			ORDER BY agent_id ASC`,
		),
		db.prepare(
			`SELECT d.id, d.agent_id, d.status, d.attempts, d.next_attempt_at, d.leased_until, d.last_error, d.created_at, d.updated_at
			FROM webhook_deliveries d
			WHERE d.rowid = (
				SELECT d2.rowid
				FROM webhook_deliveries d2
				WHERE d2.agent_id = d.agent_id
				ORDER BY d2.updated_at DESC, d2.created_at DESC, d2.rowid DESC
				LIMIT 1
			)`,
		),
	]);

	const latestByAgent = new Map<string, WebhookDeliverySummary>();
	for (const row of (deliveriesRes?.results ?? []) as WebhookDeliveryRow[]) {
		latestByAgent.set(row.agent_id, deliverySummaryFromRow(row));
	}

	return ((webhooksRes?.results ?? []) as AgentWebhookSummaryRow[]).map((row) =>
		summaryFromRow(row, latestByAgent.get(row.agent_id) ?? null),
	);
}

/**
 * Returns one agent's webhook metadata and latest delivery status, or `null`
 * if unconfigured. Never reads or returns `secret`.
 */
export async function getAgentWebhookSummary(
	db: D1Database,
	agentId: string,
): Promise<AgentWebhookSummary | null> {
	const [webhookRes, deliveryRes] = await db.batch([
		db
			.prepare(
				`SELECT agent_id, url, auth_mode, header_name, created_at, updated_at
				FROM agent_webhooks
				WHERE agent_id = ?`,
			)
			.bind(agentId),
		db
			.prepare(
				`SELECT id, agent_id, status, attempts, next_attempt_at, leased_until, last_error, created_at, updated_at
				FROM webhook_deliveries
				WHERE agent_id = ?
				ORDER BY updated_at DESC, created_at DESC, rowid DESC
				LIMIT 1`,
			)
			.bind(agentId),
	]);

	const row = (webhookRes?.results[0] ?? null) as AgentWebhookSummaryRow | null;
	if (row === null) {
		return null;
	}
	const latestRow = (deliveryRes?.results[0] ??
		null) as WebhookDeliveryRow | null;
	return summaryFromRow(
		row,
		latestRow === null ? null : deliverySummaryFromRow(latestRow),
	);
}

/**
 * Creates or updates an agent's webhook configuration. Owner-only.
 * Records metadata only (never `secret`) in `change_log`.
 */
export async function configureAgentWebhook(
	db: D1Database,
	input: ConfigureAgentWebhookInput,
): Promise<AdminResult<ConfiguredAgentWebhook>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;
	if (ctx.value.actorType !== "owner") {
		return fail("invalid_input", "Webhook の設定は所有者のみが実行できます");
	}

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	if (!(WEBHOOK_AUTH_MODES as readonly string[]).includes(input.authMode)) {
		return fail("invalid_input", "認証方式が不正です");
	}
	const authMode = input.authMode;

	const urlCheck = validateWebhookUrl(input.url, {
		allowInsecureLocalhost: input.allowInsecureLocalhost,
	});
	if (!urlCheck.ok) {
		return fail("invalid_input", urlCheck.message);
	}

	let validatedHeaderName: string | null = null;
	if (authMode === "custom_header") {
		const headerCheck = validateCustomHeaderName(input.headerName ?? "");
		if (!headerCheck.ok) {
			return fail("invalid_input", headerCheck.message);
		}
		validatedHeaderName = headerCheck.headerName;
	}

	const [agentRes, existingRes] = await db.batch([
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(agentId.value),
		db
			.prepare("SELECT * FROM agent_webhooks WHERE agent_id = ?")
			.bind(agentId.value),
	]);

	if ((agentRes?.results.length ?? 0) === 0) {
		return fail("not_found", "指定されたエージェントが見つかりません");
	}

	const existingRow = (existingRes?.results[0] ??
		null) as AgentWebhookRow | null;
	const existing =
		existingRow === null ? null : agentWebhookFromRow(existingRow);

	let secret: string;
	let revealedSecret: string | null = null;

	if (authMode === "paab_hmac") {
		if (existing !== null && existing.authMode === "paab_hmac") {
			secret = existing.secret;
		} else {
			secret = generatePaabWebhookSecret();
			revealedSecret = secret;
		}
	} else {
		const provided = input.secret ?? "";
		if (provided.length === 0) {
			if (existing !== null && existing.authMode === authMode) {
				secret = existing.secret;
			} else {
				return fail(
					"invalid_input",
					authMode === "standard_webhooks"
						? "Standard Webhooks のシークレット（whsec_...）を入力してください"
						: "認証シークレットを入力してください",
				);
			}
		} else if (authMode === "standard_webhooks") {
			const check = validateStandardWebhooksSecret(provided);
			if (!check.ok) {
				return fail("invalid_input", check.message);
			}
			secret = check.secret;
		} else {
			const check = validateExternalSecret(provided);
			if (!check.ok) {
				return fail("invalid_input", check.message);
			}
			secret = check.secret;
		}
	}

	const createdAt = existing?.createdAt ?? ctx.value.now;
	let nextWebhook: AgentWebhook;
	if (authMode === "custom_header") {
		if (validatedHeaderName === null) {
			return fail("invalid_input", "カスタムヘッダー名を指定してください");
		}
		nextWebhook = {
			agentId: agentId.value,
			url: urlCheck.url,
			authMode,
			headerName: validatedHeaderName,
			secret,
			createdAt,
			updatedAt: ctx.value.now,
		};
	} else {
		nextWebhook = {
			agentId: agentId.value,
			url: urlCheck.url,
			authMode,
			secret,
			createdAt,
			updatedAt: ctx.value.now,
		};
	}

	const changeId = await runWithChangeLog(
		db,
		[upsertAgentWebhook(db, nextWebhook)],
		{
			occurredAt: ctx.value.now,
			actorType: "owner",
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "webhook_configured",
			targetType: "agent",
			targetId: agentId.value,
			beforeJson:
				existing === null ? null : JSON.stringify(toAuditSnapshot(existing)),
			afterJson: JSON.stringify(toAuditSnapshot(nextWebhook)),
			revertedAt: null,
		},
	);

	const summary = await getAgentWebhookSummary(db, agentId.value);
	if (summary === null) {
		throw new Error("Configured webhook disappeared after save");
	}

	return {
		ok: true,
		data: {
			webhook: summary,
			revealedSecret,
			created: existing === null,
		},
		changeId,
	};
}

/**
 * Rotates the signing secret for a `paab_hmac` webhook. Owner-only.
 * Returns the newly generated secret once; logs metadata only in `change_log`.
 */
export async function rotateAgentWebhookSecret(
	db: D1Database,
	input: RotateAgentWebhookSecretInput,
): Promise<AdminResult<RotatedAgentWebhookSecret>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;
	if (ctx.value.actorType !== "owner") {
		return fail(
			"invalid_input",
			"Webhook 鍵のローテーションは所有者のみが実行できます",
		);
	}

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const existingRow = await db
		.prepare("SELECT * FROM agent_webhooks WHERE agent_id = ?")
		.bind(agentId.value)
		.first<AgentWebhookRow>();
	if (existingRow === null) {
		return fail(
			"not_found",
			"このエージェントには Webhook が設定されていません",
		);
	}
	const existing = agentWebhookFromRow(existingRow);
	if (existing.authMode !== "paab_hmac") {
		return fail(
			"invalid_input",
			"鍵の自動ローテーションは paab_hmac 方式のときのみ実行できます",
		);
	}

	const newSecret = generatePaabWebhookSecret();
	const snapshot = toAuditSnapshot(existing);

	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare(
					"UPDATE agent_webhooks SET secret = ?, updated_at = ? WHERE agent_id = ?",
				)
				.bind(newSecret, ctx.value.now, agentId.value),
		],
		{
			occurredAt: ctx.value.now,
			actorType: "owner",
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "webhook_secret_rotated",
			targetType: "agent",
			targetId: agentId.value,
			beforeJson: JSON.stringify(snapshot),
			afterJson: JSON.stringify(snapshot),
			revertedAt: null,
		},
	);

	const summary = await getAgentWebhookSummary(db, agentId.value);
	if (summary === null) {
		throw new Error("Rotated webhook disappeared after update");
	}

	return {
		ok: true,
		data: {
			webhook: summary,
			revealedSecret: newSecret,
		},
		changeId,
	};
}

/**
 * Deletes an agent's webhook configuration and any pending deliveries for that
 * agent. Owner-only. Records metadata only in `change_log`.
 */
export async function deleteAgentWebhook(
	db: D1Database,
	input: DeleteAgentWebhookInput,
): Promise<AdminResult<DeletedAgentWebhook>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;
	if (ctx.value.actorType !== "owner") {
		return fail("invalid_input", "Webhook の削除は所有者のみが実行できます");
	}

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const existingRow = await db
		.prepare("SELECT * FROM agent_webhooks WHERE agent_id = ?")
		.bind(agentId.value)
		.first<AgentWebhookRow>();
	if (existingRow === null) {
		return fail(
			"not_found",
			"このエージェントには Webhook が設定されていません",
		);
	}
	const existing = agentWebhookFromRow(existingRow);
	const snapshot = toAuditSnapshot(existing);

	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare(
					"DELETE FROM webhook_deliveries WHERE agent_id = ? AND status = 'pending'",
				)
				.bind(agentId.value),
			db
				.prepare("DELETE FROM agent_webhooks WHERE agent_id = ?")
				.bind(agentId.value),
		],
		{
			occurredAt: ctx.value.now,
			actorType: "owner",
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "webhook_deleted",
			targetType: "agent",
			targetId: agentId.value,
			beforeJson: JSON.stringify(snapshot),
			afterJson: null,
			revertedAt: null,
		},
	);

	return {
		ok: true,
		data: { deleted: snapshot },
		changeId,
	};
}
