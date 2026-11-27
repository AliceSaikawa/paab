import type { AdminErrorCode, ChangeActor } from "../admin";
import {
	fail as adminFail,
	validateContext,
	validateDescription,
	validateId,
} from "../admin/validate";
import {
	type AgentRow,
	agentFromRow,
	oneOf,
	type PendingDescriptionRow,
	pendingDescriptionFromRow,
	upsertPendingDescription,
} from "../db";
import {
	AGENT_STATUSES,
	type Agent,
	type AgentStatus,
	type PendingDescription,
	type UnixMillis,
} from "../types";
import { getAdminBotConfig } from "./config";

export type DescriptionErrorCode = AdminErrorCode | "self_approval_forbidden";

export interface DescriptionFailure {
	ok: false;
	code: DescriptionErrorCode;
	message: string;
}

export type DescriptionResult<T, C extends number | null = number> =
	| { ok: true; data: T; changeId: C }
	| DescriptionFailure;

export interface SubmitPendingDescriptionInput {
	agentId: string;
	description: string;
	now: UnixMillis;
}

export type SubmitPendingDescriptionResult =
	| { ok: true; data: { pending: PendingDescription; replaced: boolean } }
	| DescriptionFailure;

export interface PendingDescriptionView {
	agentId: string;
	agentName: string;
	agentStatus: AgentStatus;
	currentDescription: string;
	pendingDescription: string;
	submittedAt: UnixMillis;
	isAdminBot: boolean;
}

export interface ReviewPendingDescriptionInput {
	agentId: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface ApprovedDescriptionData {
	agent: Agent;
	previousDescription: string;
	approvedDescription: string;
}

export interface RejectedDescriptionData {
	agent: Agent;
	rejectedDescription: string;
}

interface PendingDescriptionJoinRow {
	agent_id: string;
	pending_description: string;
	submitted_at: number;
	agent_name: string;
	agent_status: string;
	current_description: string;
}

function fail(code: DescriptionErrorCode, message: string): DescriptionFailure {
	return { ok: false, code, message };
}

/**
 * Stores or replaces an agent's pending description draft without touching
 * `agents.description` (design 5.4).
 */
export async function submitPendingDescription(
	db: D1Database,
	input: SubmitPendingDescriptionInput,
): Promise<SubmitPendingDescriptionResult> {
	if (!Number.isSafeInteger(input.now)) {
		return adminFail("invalid_input", "時刻は整数で指定してください");
	}
	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const description = validateDescription(input.description);
	if (!description.ok) return description;

	const [agentResult, existingPendingResult] = await db.batch([
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(agentId.value),
		db
			.prepare("SELECT agent_id FROM pending_descriptions WHERE agent_id = ?")
			.bind(agentId.value),
	]);
	if ((agentResult?.results.length ?? 0) === 0) {
		return adminFail("not_found", "指定されたエージェントが見つかりません");
	}

	const pending: PendingDescription = {
		agentId: agentId.value,
		description: description.value,
		submittedAt: input.now,
	};
	await upsertPendingDescription(db, pending).run();

	return {
		ok: true,
		data: {
			pending,
			replaced: (existingPendingResult?.results.length ?? 0) > 0,
		},
	};
}

/**
 * Lists all pending descriptions ordered oldest first, joined with agent
 * metadata and whether each agent is the currently designated admin bot.
 */
export async function listPendingDescriptions(
	db: D1Database,
): Promise<PendingDescriptionView[]> {
	const [rowsResult, config] = await Promise.all([
		db
			.prepare(
				`SELECT
					pd.agent_id,
					pd.description AS pending_description,
					pd.submitted_at,
					a.name AS agent_name,
					a.status AS agent_status,
					a.description AS current_description
				FROM pending_descriptions pd
				INNER JOIN agents a ON a.id = pd.agent_id
				ORDER BY pd.submitted_at ASC, pd.agent_id ASC`,
			)
			.all<PendingDescriptionJoinRow>(),
		getAdminBotConfig(db),
	]);

	return rowsResult.results.map((row) => ({
		agentId: row.agent_id,
		agentName: row.agent_name,
		agentStatus: oneOf(AGENT_STATUSES, row.agent_status, "agents.status"),
		currentDescription: row.current_description,
		pendingDescription: row.pending_description,
		submittedAt: row.submitted_at,
		isAdminBot: config.agentId !== null && config.agentId === row.agent_id,
	}));
}

/**
 * Approves an agent's pending description, atomically publishing it into
 * `agents.description`, deleting the pending row, and logging
 * `description_approved` in `change_log`.
 *
 * Refuses self-approval when `actor` is `admin_bot` matching `agentId`
 * (design 5.4).
 */
export async function approvePendingDescription(
	db: D1Database,
	input: ReviewPendingDescriptionInput,
): Promise<DescriptionResult<ApprovedDescriptionData>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	if (
		ctx.value.actorType === "admin_bot" &&
		ctx.value.actorId === agentId.value
	) {
		return fail(
			"self_approval_forbidden",
			"管理者ボットは自身の説明文を承認できません。管理画面から所有者が承認してください",
		);
	}

	const [agentResult, pendingResult] = await db.batch([
		db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId.value),
		db
			.prepare("SELECT * FROM pending_descriptions WHERE agent_id = ?")
			.bind(agentId.value),
	]);
	const agentRow = (agentResult?.results[0] ?? null) as AgentRow | null;
	if (agentRow === null) {
		return adminFail("not_found", "指定されたエージェントが見つかりません");
	}
	const pendingRow = (pendingResult?.results[0] ??
		null) as PendingDescriptionRow | null;
	if (pendingRow === null) {
		return adminFail("not_found", "承認待ちの説明文が見つかりません");
	}

	const agent = agentFromRow(agentRow);
	const pending = pendingDescriptionFromRow(pendingRow);
	const checkedDescription = validateDescription(pending.description);
	if (!checkedDescription.ok) {
		return checkedDescription;
	}
	const nextDescription = checkedDescription.value;

	const beforeJson = JSON.stringify({
		agentId: agent.id,
		name: agent.name,
		description: agent.description,
	});
	const afterJson = JSON.stringify({
		agentId: agent.id,
		name: agent.name,
		description: nextDescription,
	});
	const [, changeRes, deleteRes] = await db.batch([
		db
			.prepare(
				`UPDATE agents
				SET description = ?
				WHERE id = ?
					AND EXISTS (
						SELECT 1 FROM pending_descriptions
						WHERE agent_id = ? AND submitted_at = ? AND description = ?
					)`,
			)
			.bind(
				nextDescription,
				agent.id,
				agent.id,
				pending.submittedAt,
				pending.description,
			),
		db
			.prepare(
				`INSERT INTO change_log
					(occurred_at, actor_type, actor_id, approver_id, action,
					target_type, target_id, before_json, after_json, reverted_at)
				SELECT ?, ?, ?, ?, 'description_approved', 'description', ?, ?, ?, NULL
				WHERE EXISTS (
					SELECT 1 FROM pending_descriptions
					WHERE agent_id = ? AND submitted_at = ? AND description = ?
				)`,
			)
			.bind(
				ctx.value.now,
				ctx.value.actorType,
				ctx.value.actorId,
				ctx.value.approverId,
				agent.id,
				beforeJson,
				afterJson,
				agent.id,
				pending.submittedAt,
				pending.description,
			),
		db
			.prepare(
				`DELETE FROM pending_descriptions
				WHERE agent_id = ? AND submitted_at = ? AND description = ?`,
			)
			.bind(agent.id, pending.submittedAt, pending.description),
	]);
	if ((deleteRes?.meta.changes ?? 0) === 0) {
		return adminFail(
			"not_found",
			"承認待ちの説明文が更新または処理されたため承認できませんでした",
		);
	}
	const changeId = Number(changeRes?.meta.last_row_id);
	if (!Number.isSafeInteger(changeId) || changeId <= 0) {
		throw new Error("change_log insert did not return a valid last_row_id");
	}

	return {
		ok: true,
		data: {
			agent: { ...agent, description: nextDescription },
			previousDescription: agent.description,
			approvedDescription: nextDescription,
		},
		changeId,
	};
}

/**
 * Rejects an agent's pending description, atomically deleting the pending row
 * without modifying `agents.description` and logging `description_rejected` in
 * `change_log`.
 *
 * Refuses self-rejection when `actor` is `admin_bot` matching `agentId`
 * (design 5.4).
 */
export async function rejectPendingDescription(
	db: D1Database,
	input: ReviewPendingDescriptionInput,
): Promise<DescriptionResult<RejectedDescriptionData>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	if (
		ctx.value.actorType === "admin_bot" &&
		ctx.value.actorId === agentId.value
	) {
		return fail(
			"self_approval_forbidden",
			"管理者ボットは自身の説明文を却下できません。管理画面から所有者が処理してください",
		);
	}

	const [agentResult, pendingResult] = await db.batch([
		db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId.value),
		db
			.prepare("SELECT * FROM pending_descriptions WHERE agent_id = ?")
			.bind(agentId.value),
	]);
	const agentRow = (agentResult?.results[0] ?? null) as AgentRow | null;
	if (agentRow === null) {
		return adminFail("not_found", "指定されたエージェントが見つかりません");
	}
	const pendingRow = (pendingResult?.results[0] ??
		null) as PendingDescriptionRow | null;
	if (pendingRow === null) {
		return adminFail("not_found", "承認待ちの説明文が見つかりません");
	}

	const agent = agentFromRow(agentRow);
	const pending = pendingDescriptionFromRow(pendingRow);

	const beforeJson = JSON.stringify({
		agentId: agent.id,
		name: agent.name,
		description: pending.description,
	});
	const [changeRes, deleteRes] = await db.batch([
		db
			.prepare(
				`INSERT INTO change_log
					(occurred_at, actor_type, actor_id, approver_id, action,
					target_type, target_id, before_json, after_json, reverted_at)
				SELECT ?, ?, ?, ?, 'description_rejected', 'description', ?, ?, NULL, NULL
				WHERE EXISTS (
					SELECT 1 FROM pending_descriptions
					WHERE agent_id = ? AND submitted_at = ? AND description = ?
				)`,
			)
			.bind(
				ctx.value.now,
				ctx.value.actorType,
				ctx.value.actorId,
				ctx.value.approverId,
				agent.id,
				beforeJson,
				agent.id,
				pending.submittedAt,
				pending.description,
			),
		db
			.prepare(
				`DELETE FROM pending_descriptions
				WHERE agent_id = ? AND submitted_at = ? AND description = ?`,
			)
			.bind(agent.id, pending.submittedAt, pending.description),
	]);
	if ((deleteRes?.meta.changes ?? 0) === 0) {
		return adminFail(
			"not_found",
			"承認待ちの説明文が更新または処理されたため却下できませんでした",
		);
	}
	const changeId = Number(changeRes?.meta.last_row_id);
	if (!Number.isSafeInteger(changeId) || changeId <= 0) {
		throw new Error("change_log insert did not return a valid last_row_id");
	}

	return {
		ok: true,
		data: {
			agent,
			rejectedDescription: pending.description,
		},
		changeId,
	};
}
