import {
	type AgentRow,
	type AllowRuleRow,
	agentFromRow,
	allowRuleFromRow,
	insertAgent,
	newId,
} from "../db";
import type { Agent, AgentStatus } from "../types";
import { resolveDefaultOwnerId } from "./query";
import type {
	AdminResult,
	AgentDeletionSnapshot,
	AgentStatusChangeInput,
	DeleteAgentInput,
	DeletedAgentSummary,
	RegisterAgentInput,
	UpdateAgentInput,
	UpdateAgentResult,
} from "./types";
import {
	fail,
	isUniqueConstraintError,
	runWithChangeLog,
	validateAgentStatus,
	validateContext,
	validateDailyLimit,
	validateDescription,
	validateId,
	validateName,
	validateOwnerId,
} from "./validate";

export async function registerAgent(
	db: D1Database,
	input: RegisterAgentInput,
): Promise<AdminResult<{ agent: Agent }>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const name = validateName(input.name);
	if (!name.ok) return name;

	const description = validateDescription(input.description ?? "");
	if (!description.ok) return description;

	const limit = validateDailyLimit(input.dailyQuestionLimit);
	if (!limit.ok) return limit;

	const ownerCheck =
		input.ownerId !== undefined ? validateOwnerId(input.ownerId) : null;
	if (ownerCheck !== null && !ownerCheck.ok) return ownerCheck;

	const status = validateAgentStatus(input.status ?? "active");
	if (!status.ok) return status;

	const existing = await db
		.prepare("SELECT id FROM agents WHERE name = ?")
		.bind(name.value)
		.first<{ id: string }>();
	if (existing !== null) {
		return fail(
			"duplicate_name",
			`エージェント「${name.value}」はすでに登録されています`,
		);
	}

	const ownerId =
		ownerCheck !== null ? ownerCheck.value : await resolveDefaultOwnerId(db);
	const agent: Agent = {
		id: newId(),
		ownerId,
		name: name.value,
		description: description.value,
		status: status.value,
		dailyQuestionLimit: limit.value,
		createdAt: ctx.value.now,
	};

	try {
		const changeId = await runWithChangeLog(db, [insertAgent(db, agent)], {
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "agent_registered",
			targetType: "agent",
			targetId: agent.id,
			beforeJson: null,
			afterJson: JSON.stringify(agent),
			revertedAt: null,
		});
		return { ok: true, data: { agent }, changeId };
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			return fail(
				"duplicate_name",
				`エージェント「${name.value}」はすでに登録されています`,
			);
		}
		throw error;
	}
}

export async function updateAgent(
	db: D1Database,
	input: UpdateAgentInput,
): Promise<UpdateAgentResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const nameCheck = input.name !== undefined ? validateName(input.name) : null;
	if (nameCheck !== null && !nameCheck.ok) return nameCheck;

	const descCheck =
		input.description !== undefined
			? validateDescription(input.description)
			: null;
	if (descCheck !== null && !descCheck.ok) return descCheck;

	const limitCheck =
		input.dailyQuestionLimit !== undefined
			? validateDailyLimit(input.dailyQuestionLimit)
			: null;
	if (limitCheck !== null && !limitCheck.ok) return limitCheck;

	const row = await db
		.prepare("SELECT * FROM agents WHERE id = ?")
		.bind(agentId.value)
		.first<AgentRow>();
	if (row === null) {
		return fail("not_found", "指定されたエージェントが見つかりません");
	}
	const current = agentFromRow(row);

	const nextName = nameCheck !== null ? nameCheck.value : current.name;
	const nextDescription =
		descCheck !== null ? descCheck.value : current.description;
	const nextLimit =
		limitCheck !== null ? limitCheck.value : current.dailyQuestionLimit;

	if (
		nextName === current.name &&
		nextDescription === current.description &&
		nextLimit === current.dailyQuestionLimit
	) {
		return {
			ok: true,
			data: { agent: current, changed: false },
			changeId: null,
		};
	}

	if (nextName !== current.name) {
		const duplicate = await db
			.prepare("SELECT id FROM agents WHERE name = ? AND id <> ?")
			.bind(nextName, current.id)
			.first<{ id: string }>();
		if (duplicate !== null) {
			return fail(
				"duplicate_name",
				`エージェント「${nextName}」はすでに登録されています`,
			);
		}
	}

	const updated: Agent = {
		...current,
		name: nextName,
		description: nextDescription,
		dailyQuestionLimit: nextLimit,
	};

	try {
		const changeId = await runWithChangeLog(
			db,
			[
				db
					.prepare(
						"UPDATE agents SET name = ?, description = ?, daily_question_limit = ? WHERE id = ?",
					)
					.bind(
						updated.name,
						updated.description,
						updated.dailyQuestionLimit,
						updated.id,
					),
			],
			{
				occurredAt: ctx.value.now,
				actorType: ctx.value.actorType,
				actorId: ctx.value.actorId,
				approverId: ctx.value.approverId,
				action: "agent_updated",
				targetType: "agent",
				targetId: updated.id,
				beforeJson: JSON.stringify(current),
				afterJson: JSON.stringify(updated),
				revertedAt: null,
			},
		);
		return { ok: true, data: { agent: updated, changed: true }, changeId };
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			return fail(
				"duplicate_name",
				`エージェント「${nextName}」はすでに登録されています`,
			);
		}
		throw error;
	}
}

export async function deleteAgent(
	db: D1Database,
	input: DeleteAgentInput,
): Promise<AdminResult<DeletedAgentSummary>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const [agentResult, rulesResult] = await db.batch([
		db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId.value),
		db
			.prepare(
				`SELECT * FROM allow_rules
				WHERE from_agent_id = ? OR to_agent_id = ?
				ORDER BY from_agent_id, to_agent_id, category_id`,
			)
			.bind(agentId.value, agentId.value),
	]);
	const agentRow = (agentResult?.results[0] ?? null) as AgentRow | null;
	if (agentRow === null) {
		return fail("not_found", "指定されたエージェントが見つかりません");
	}
	const agent = agentFromRow(agentRow);
	const allowRules = ((rulesResult?.results ?? []) as AllowRuleRow[]).map(
		allowRuleFromRow,
	);
	const snapshot: AgentDeletionSnapshot = { agent, allowRules };

	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare(
					`UPDATE admin_bot_config
					SET agent_id = NULL, read_bodies = 0, superadmin_until = NULL, updated_at = ?
					WHERE id = 1 AND agent_id = ?`,
				)
				.bind(ctx.value.now, agent.id),
			db.prepare("DELETE FROM agents WHERE id = ?").bind(agent.id),
		],
		{
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "agent_deleted",
			targetType: "agent",
			targetId: agent.id,
			beforeJson: JSON.stringify(snapshot),
			afterJson: null,
			revertedAt: null,
		},
	);
	return {
		ok: true,
		data: { agent, deletedAllowRuleCount: allowRules.length },
		changeId,
	};
}

async function setAgentStatus(
	db: D1Database,
	input: AgentStatusChangeInput,
	nextStatus: AgentStatus,
): Promise<AdminResult<{ agent: Agent }>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const row = await db
		.prepare("SELECT * FROM agents WHERE id = ?")
		.bind(agentId.value)
		.first<AgentRow>();
	if (row === null) {
		return fail("not_found", "指定されたエージェントが見つかりません");
	}
	const current = agentFromRow(row);
	if (current.status === nextStatus) {
		return nextStatus === "suspended"
			? fail("already_suspended", "このエージェントはすでに停止中です")
			: fail("already_active", "このエージェントはすでに有効です");
	}

	const updated: Agent = { ...current, status: nextStatus };
	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare("UPDATE agents SET status = ? WHERE id = ?")
				.bind(nextStatus, current.id),
		],
		{
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: nextStatus === "suspended" ? "agent_suspended" : "agent_resumed",
			targetType: "agent",
			targetId: current.id,
			beforeJson: JSON.stringify(current),
			afterJson: JSON.stringify(updated),
			revertedAt: null,
		},
	);
	return { ok: true, data: { agent: updated }, changeId };
}

export async function suspendAgent(
	db: D1Database,
	input: AgentStatusChangeInput,
): Promise<AdminResult<{ agent: Agent }>> {
	return setAgentStatus(db, input, "suspended");
}

export async function resumeAgent(
	db: D1Database,
	input: AgentStatusChangeInput,
): Promise<AdminResult<{ agent: Agent }>> {
	return setAgentStatus(db, input, "active");
}
