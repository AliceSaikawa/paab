import { generateWebhookSecret, validateWebhookUrl } from "../notify";
import type { AgentWebhookSummary } from "../types";
import type {
	AdminResult,
	ConfigureAgentWebhookInput,
	ConfiguredAgentWebhook,
	DeleteAgentWebhookInput,
	DeleteAgentWebhookResult,
} from "./types";
import {
	fail,
	runWithChangeLog,
	validateContext,
	validateId,
} from "./validate";

interface WebhookSummaryRow {
	agent_id: string;
	url: string;
	created_at: number;
	updated_at: number;
}

function summaryFromRow(row: WebhookSummaryRow): AgentWebhookSummary {
	return {
		agentId: row.agent_id,
		url: row.url,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Lists configured webhook metadata per agent without reading `signing_secret`. */
export async function listAgentWebhooks(
	db: D1Database,
): Promise<Map<string, AgentWebhookSummary>> {
	const { results } = await db
		.prepare("SELECT agent_id, url, created_at, updated_at FROM agent_webhooks")
		.all<WebhookSummaryRow>();
	return new Map(results.map((row) => [row.agent_id, summaryFromRow(row)]));
}

/**
 * Registers or updates an agent's webhook URL and generates a fresh
 * `signing_secret` (returned once; never stored in `change_log`).
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

	const urlCheck = validateWebhookUrl(input.url, input.allowLocal ?? false);
	if (!urlCheck.ok) {
		return fail("invalid_input", urlCheck.message);
	}

	const [agentResult, existingResult] = await db.batch([
		db.prepare("SELECT id, name FROM agents WHERE id = ?").bind(agentId.value),
		db
			.prepare(
				"SELECT agent_id, url, created_at, updated_at FROM agent_webhooks WHERE agent_id = ?",
			)
			.bind(agentId.value),
	]);
	const agentRow = (agentResult?.results[0] ?? null) as {
		id: string;
		name: string;
	} | null;
	if (agentRow === null) {
		return fail("not_found", "指定されたエージェントが見つかりません");
	}
	const existing = (existingResult?.results[0] ??
		null) as WebhookSummaryRow | null;

	const signingSecret = generateWebhookSecret();
	const createdAt = existing?.created_at ?? ctx.value.now;
	const updatedAt = ctx.value.now;

	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare(
					`INSERT INTO agent_webhooks (agent_id, url, signing_secret, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(agent_id) DO UPDATE SET
						url = excluded.url,
						signing_secret = excluded.signing_secret,
						updated_at = excluded.updated_at`,
				)
				.bind(agentRow.id, urlCheck.url, signingSecret, createdAt, updatedAt),
		],
		{
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "webhook_configured",
			targetType: "agent",
			targetId: agentRow.id,
			beforeJson:
				existing !== null ? JSON.stringify({ url: existing.url }) : null,
			afterJson: JSON.stringify({ url: urlCheck.url }),
			revertedAt: null,
		},
	);

	return {
		ok: true,
		data: {
			agentId: agentRow.id,
			agentName: agentRow.name,
			url: urlCheck.url,
			signingSecret,
			replacedPrevious: existing !== null,
			createdAt,
			updatedAt,
		},
		changeId,
	};
}

/**
 * Deletes an agent's webhook configuration and cancels any pending deliveries.
 */
export async function deleteAgentWebhook(
	db: D1Database,
	input: DeleteAgentWebhookInput,
): Promise<DeleteAgentWebhookResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;
	if (ctx.value.actorType !== "owner") {
		return fail("invalid_input", "Webhook の削除は所有者のみが実行できます");
	}

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const [agentResult, existingResult] = await db.batch([
		db.prepare("SELECT id, name FROM agents WHERE id = ?").bind(agentId.value),
		db
			.prepare(
				"SELECT agent_id, url, created_at, updated_at FROM agent_webhooks WHERE agent_id = ?",
			)
			.bind(agentId.value),
	]);
	const agentRow = (agentResult?.results[0] ?? null) as {
		id: string;
		name: string;
	} | null;
	if (agentRow === null) {
		return fail("not_found", "指定されたエージェントが見つかりません");
	}
	const existing = (existingResult?.results[0] ??
		null) as WebhookSummaryRow | null;
	if (existing === null) {
		return {
			ok: true,
			data: { deleted: false, agentName: agentRow.name, url: null },
			changeId: null,
		};
	}

	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare("DELETE FROM agent_webhooks WHERE agent_id = ?")
				.bind(agentRow.id),
			db
				.prepare(
					"DELETE FROM webhook_deliveries WHERE agent_id = ? AND status = 'pending'",
				)
				.bind(agentRow.id),
		],
		{
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "webhook_deleted",
			targetType: "agent",
			targetId: agentRow.id,
			beforeJson: JSON.stringify({ url: existing.url }),
			afterJson: null,
			revertedAt: null,
		},
	);

	return {
		ok: true,
		data: { deleted: true, agentName: agentRow.name, url: existing.url },
		changeId,
	};
}
