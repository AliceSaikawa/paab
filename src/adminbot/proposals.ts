import {
	type ChangeActor,
	createCategory,
	grantAllowRule,
	resumeAgent,
	updateAgent,
} from "../admin";
import {
	type AgentRow,
	agentFromRow,
	insertProposal,
	newId,
	type ProposalRow,
	proposalFromRow,
} from "../db";
import {
	descriptionProblem,
	nameProblem,
	normalizeDescription,
	normalizeName,
} from "../policy";
import {
	PROPOSAL_STATUSES,
	type Proposal,
	type ProposalPayload,
	type ProposalStatus,
	type UnixMillis,
} from "../types";

/** Maximum number of active (non-expired) pending proposals allowed at once (design 5.3). */
export const MAX_PENDING_PROPOSALS = 20;

/** Unprocessed proposals expire automatically after 14 days (design 5.3). */
export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Maximum length of a proposal's reason text, in UTF-16 code units. */
export const PROPOSAL_REASON_MAX_LENGTH = 1000;

export const DEFAULT_PROPOSAL_LIST_LIMIT = 50;
export const MAX_PROPOSAL_LIST_LIMIT = 100;

export type ProposalErrorCode =
	| "invalid_input"
	| "invalid_name"
	| "invalid_limit"
	| "invalid_reason"
	| "not_found"
	| "duplicate_rule"
	| "duplicate_name"
	| "self_addressed"
	| "already_active"
	| "limit_not_raised"
	| "pending_limit_reached"
	| "already_resolved"
	| "expired"
	| "premise_changed";

export interface ProposalFailure {
	ok: false;
	code: ProposalErrorCode;
	message: string;
}

export type ProposalResult<T> = { ok: true; data: T } | ProposalFailure;

export interface CreateProposalInput {
	proposerAgentId: string;
	payload: ProposalPayload;
	reason: string;
	now: UnixMillis;
}

export interface ListProposalsFilter {
	status?: ProposalStatus;
	proposerAgentId?: string;
	limit?: number;
	now: UnixMillis;
}

export interface ResolveProposalInput {
	proposalId: string;
	approverId: string;
	now: UnixMillis;
}

export interface ProposalEffectNames {
	agents: Map<string, string>;
	categories: Map<string, string>;
	agentLimits?: Map<string, number>;
}

function fail(code: ProposalErrorCode, message: string): ProposalFailure {
	return { ok: false, code, message };
}

function validateReason(
	raw: string,
): { ok: true; value: string } | ProposalFailure {
	if (typeof raw !== "string") {
		return fail("invalid_reason", "提案の理由は文字列で指定してください");
	}
	const normalized = normalizeDescription(raw).trim();
	if (normalized.length === 0) {
		return fail("invalid_reason", "提案の理由を入力してください");
	}
	if (normalized.length > PROPOSAL_REASON_MAX_LENGTH) {
		return fail(
			"invalid_reason",
			`提案の理由は${PROPOSAL_REASON_MAX_LENGTH}文字以内にしてください（${normalized.length}文字あります）`,
		);
	}
	const problem = descriptionProblem(normalized);
	if (problem !== null) {
		return fail("invalid_reason", problem);
	}
	return { ok: true, value: normalized };
}

function activePendingCountQuery(
	db: D1Database,
	now: UnixMillis,
): D1PreparedStatement {
	return db
		.prepare(
			"SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending' AND expires_at > ?",
		)
		.bind(now);
}

function countFromResult(result: D1Result | undefined): number {
	const row = (result?.results[0] ?? null) as { n?: unknown } | null;
	return typeof row?.n === "number" ? row.n : Number(row?.n ?? 0);
}

/**
 * Records a pending loosening proposal from the admin bot.
 * Never mutates live rules, categories, or agents.
 */
export async function createProposal(
	db: D1Database,
	input: CreateProposalInput,
): Promise<ProposalResult<{ proposal: Proposal }>> {
	if (!Number.isSafeInteger(input.now)) {
		return fail("invalid_input", "時刻は整数で指定してください");
	}
	if (
		typeof input.proposerAgentId !== "string" ||
		input.proposerAgentId.trim().length === 0
	) {
		return fail("invalid_input", "提案元エージェントIDを指定してください");
	}

	const reasonCheck = validateReason(input.reason);
	if (!reasonCheck.ok) {
		return reasonCheck;
	}

	const proposerId = input.proposerAgentId;
	let normalizedPayload: ProposalPayload;
	let pendingCount: number;

	switch (input.payload.kind) {
		case "grant_allow_rule": {
			const { fromAgentId, toAgentId, categoryId } = input.payload;
			if (
				typeof fromAgentId !== "string" ||
				fromAgentId.trim().length === 0 ||
				typeof toAgentId !== "string" ||
				toAgentId.trim().length === 0 ||
				typeof categoryId !== "string" ||
				categoryId.trim().length === 0
			) {
				return fail(
					"invalid_input",
					"送信元・宛先エージェントIDとカテゴリIDを指定してください",
				);
			}
			if (fromAgentId === toAgentId) {
				return fail(
					"self_addressed",
					"自分自身への質問を許可するルールは提案できません",
				);
			}

			const [
				proposerRes,
				fromRes,
				toRes,
				catRes,
				existingRuleRes,
				pendingCountRes,
			] = await db.batch([
				db.prepare("SELECT id FROM agents WHERE id = ?").bind(proposerId),
				db.prepare("SELECT id FROM agents WHERE id = ?").bind(fromAgentId),
				db.prepare("SELECT id FROM agents WHERE id = ?").bind(toAgentId),
				db.prepare("SELECT id FROM categories WHERE id = ?").bind(categoryId),
				db
					.prepare(
						`SELECT 1 AS found FROM allow_rules
						WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
					)
					.bind(fromAgentId, toAgentId, categoryId),
				activePendingCountQuery(db, input.now),
			]);

			if ((proposerRes?.results.length ?? 0) === 0) {
				return fail("not_found", "提案元エージェントが見つかりません");
			}
			if ((fromRes?.results.length ?? 0) === 0) {
				return fail("not_found", "送信元エージェントが見つかりません");
			}
			if ((toRes?.results.length ?? 0) === 0) {
				return fail("not_found", "宛先エージェントが見つかりません");
			}
			if ((catRes?.results.length ?? 0) === 0) {
				return fail("not_found", "カテゴリが見つかりません");
			}
			if ((existingRuleRes?.results.length ?? 0) > 0) {
				return fail("duplicate_rule", "同じ許可ルールがすでに存在します");
			}
			pendingCount = countFromResult(pendingCountRes);
			normalizedPayload = {
				kind: "grant_allow_rule",
				fromAgentId,
				toAgentId,
				categoryId,
			};
			break;
		}
		case "create_category": {
			if (typeof input.payload.name !== "string") {
				return fail("invalid_name", "カテゴリ名は文字列で指定してください");
			}
			const problem = nameProblem(input.payload.name);
			if (problem !== null) {
				return fail("invalid_name", problem);
			}
			const name = normalizeName(input.payload.name);

			const [proposerRes, existingCatRes, pendingCountRes] = await db.batch([
				db.prepare("SELECT id FROM agents WHERE id = ?").bind(proposerId),
				db.prepare("SELECT id FROM categories WHERE name = ?").bind(name),
				activePendingCountQuery(db, input.now),
			]);

			if ((proposerRes?.results.length ?? 0) === 0) {
				return fail("not_found", "提案元エージェントが見つかりません");
			}
			if ((existingCatRes?.results.length ?? 0) > 0) {
				return fail("duplicate_name", `カテゴリ「${name}」はすでに存在します`);
			}
			pendingCount = countFromResult(pendingCountRes);
			normalizedPayload = { kind: "create_category", name };
			break;
		}
		case "raise_daily_limit": {
			const { agentId, newLimit } = input.payload;
			if (typeof agentId !== "string" || agentId.trim().length === 0) {
				return fail("invalid_input", "エージェントIDを指定してください");
			}
			if (!Number.isSafeInteger(newLimit) || newLimit < 0) {
				return fail(
					"invalid_limit",
					"1日あたりの質問数上限は0以上の整数にしてください",
				);
			}

			const [proposerRes, targetRes, pendingCountRes] = await db.batch([
				db.prepare("SELECT id FROM agents WHERE id = ?").bind(proposerId),
				db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId),
				activePendingCountQuery(db, input.now),
			]);

			if ((proposerRes?.results.length ?? 0) === 0) {
				return fail("not_found", "提案元エージェントが見つかりません");
			}
			const targetRow = (targetRes?.results[0] ?? null) as AgentRow | null;
			if (targetRow === null) {
				return fail("not_found", "指定されたエージェントが見つかりません");
			}
			const target = agentFromRow(targetRow);
			if (newLimit <= target.dailyQuestionLimit) {
				return fail(
					"limit_not_raised",
					`新しい上限（${newLimit}）は現在の上限（${target.dailyQuestionLimit}）より大きくする必要があります`,
				);
			}
			pendingCount = countFromResult(pendingCountRes);
			normalizedPayload = { kind: "raise_daily_limit", agentId, newLimit };
			break;
		}
		case "resume_agent": {
			const { agentId } = input.payload;
			if (typeof agentId !== "string" || agentId.trim().length === 0) {
				return fail("invalid_input", "エージェントIDを指定してください");
			}

			const [proposerRes, targetRes, pendingCountRes] = await db.batch([
				db.prepare("SELECT id FROM agents WHERE id = ?").bind(proposerId),
				db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId),
				activePendingCountQuery(db, input.now),
			]);

			if ((proposerRes?.results.length ?? 0) === 0) {
				return fail("not_found", "提案元エージェントが見つかりません");
			}
			const targetRow = (targetRes?.results[0] ?? null) as AgentRow | null;
			if (targetRow === null) {
				return fail("not_found", "指定されたエージェントが見つかりません");
			}
			const target = agentFromRow(targetRow);
			if (target.status !== "suspended") {
				return fail("already_active", "このエージェントはすでに有効です");
			}
			pendingCount = countFromResult(pendingCountRes);
			normalizedPayload = { kind: "resume_agent", agentId };
			break;
		}
	}

	if (pendingCount >= MAX_PENDING_PROPOSALS) {
		return fail(
			"pending_limit_reached",
			`保留中の提案数が上限（${MAX_PENDING_PROPOSALS} 件）に達しているため、新しい提案を作成できません`,
		);
	}

	const proposal: Proposal = {
		id: newId(),
		kind: normalizedPayload.kind,
		proposerAgentId: proposerId,
		payload: normalizedPayload,
		reason: reasonCheck.value,
		status: "pending",
		createdAt: input.now,
		expiresAt: input.now + PROPOSAL_TTL_MS,
		resolvedAt: null,
		resolvedBy: null,
		changeLogId: null,
	};

	await insertProposal(db, proposal).run();
	return { ok: true, data: { proposal } };
}

/**
 * Lists proposals newest-first, treating overdue `pending` rows (`expires_at <= now`)
 * as effectively `expired` even before scheduled maintenance runs.
 */
export async function listProposals(
	db: D1Database,
	filter: ListProposalsFilter,
): Promise<Proposal[]> {
	if (!Number.isSafeInteger(filter.now)) {
		throw new RangeError("now must be a safe integer");
	}
	if (
		filter.status !== undefined &&
		!(PROPOSAL_STATUSES as readonly string[]).includes(filter.status)
	) {
		throw new RangeError(`Unknown proposal status: ${filter.status}`);
	}

	const rawLimit = filter.limit ?? DEFAULT_PROPOSAL_LIST_LIMIT;
	const limit = Math.min(
		MAX_PROPOSAL_LIST_LIMIT,
		Math.max(1, Math.trunc(rawLimit)),
	);

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (filter.status === "pending") {
		conditions.push("status = 'pending' AND expires_at > ?");
		params.push(filter.now);
	} else if (filter.status === "expired") {
		conditions.push(
			"(status = 'expired' OR (status = 'pending' AND expires_at <= ?))",
		);
		params.push(filter.now);
	} else if (filter.status !== undefined) {
		conditions.push("status = ?");
		params.push(filter.status);
	}

	if (filter.proposerAgentId !== undefined) {
		conditions.push("proposer_agent_id = ?");
		params.push(filter.proposerAgentId);
	}

	const whereClause =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const sql = `SELECT * FROM proposals ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`;
	params.push(limit);

	const { results } = await db
		.prepare(sql)
		.bind(...params)
		.all<ProposalRow>();

	return results.map((row) => {
		const proposal = proposalFromRow(row);
		if (proposal.status === "pending" && proposal.expiresAt <= filter.now) {
			return { ...proposal, status: "expired" };
		}
		return proposal;
	});
}

async function markProposalExpired(
	db: D1Database,
	proposalId: string,
	now: UnixMillis,
): Promise<void> {
	await db
		.prepare(
			"UPDATE proposals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
		)
		.bind(now, proposalId)
		.run();
}

/**
 * Approves a pending proposal by applying its payload through `#29` admin
 * operations with `actorType = "admin_bot"`, `actorId = proposerAgentId`, and
 * `approverId`. Leaves the proposal pending on `premise_changed` so the owner
 * can inspect or reject it.
 */
export async function approveProposal(
	db: D1Database,
	input: ResolveProposalInput,
): Promise<ProposalResult<{ proposal: Proposal; changeId: number }>> {
	if (!Number.isSafeInteger(input.now)) {
		return fail("invalid_input", "時刻は整数で指定してください");
	}
	if (
		typeof input.proposalId !== "string" ||
		input.proposalId.trim().length === 0
	) {
		return fail("invalid_input", "提案IDを指定してください");
	}
	if (
		typeof input.approverId !== "string" ||
		input.approverId.trim().length === 0
	) {
		return fail("invalid_input", "承認者IDを指定してください");
	}

	const approverId = input.approverId.trim();
	const row = await db
		.prepare("SELECT * FROM proposals WHERE id = ?")
		.bind(input.proposalId)
		.first<ProposalRow>();
	if (row === null) {
		return fail("not_found", "指定された提案が見つかりません");
	}

	const proposal = proposalFromRow(row);
	if (proposal.status === "expired") {
		return fail(
			"expired",
			"この提案は有効期限（14日）を過ぎたため承認できません",
		);
	}
	if (proposal.status !== "pending") {
		return fail("already_resolved", "この提案はすでに処理されています");
	}
	if (proposal.expiresAt <= input.now) {
		await markProposalExpired(db, proposal.id, input.now);
		return fail(
			"expired",
			"この提案は有効期限（14日）を過ぎたため承認できません",
		);
	}

	const actor: ChangeActor = {
		actorType: "admin_bot",
		actorId: proposal.proposerAgentId,
		approverId,
	};

	let changeId: number;
	const { payload } = proposal;
	switch (payload.kind) {
		case "grant_allow_rule": {
			const result = await grantAllowRule(db, {
				fromAgentId: payload.fromAgentId,
				toAgentId: payload.toAgentId,
				categoryId: payload.categoryId,
				actor,
				now: input.now,
			});
			if (!result.ok) {
				return fail("premise_changed", result.message);
			}
			changeId = result.changeId;
			break;
		}
		case "create_category": {
			const result = await createCategory(db, {
				name: payload.name,
				actor,
				now: input.now,
			});
			if (!result.ok) {
				return fail("premise_changed", result.message);
			}
			changeId = result.changeId;
			break;
		}
		case "raise_daily_limit": {
			const agentRow = await db
				.prepare("SELECT * FROM agents WHERE id = ?")
				.bind(payload.agentId)
				.first<AgentRow>();
			if (agentRow === null) {
				return fail(
					"premise_changed",
					"指定されたエージェントが見つかりません",
				);
			}
			const target = agentFromRow(agentRow);
			if (target.dailyQuestionLimit >= payload.newLimit) {
				return fail(
					"premise_changed",
					`対象エージェント「${target.name}」の現在の上限（${target.dailyQuestionLimit} 件/日）はすでに提案値（${payload.newLimit} 件/日）以上です`,
				);
			}
			const result = await updateAgent(db, {
				agentId: payload.agentId,
				dailyQuestionLimit: payload.newLimit,
				actor,
				now: input.now,
			});
			if (!result.ok) {
				return fail("premise_changed", result.message);
			}
			if (!result.data.changed || result.changeId === null) {
				return fail(
					"premise_changed",
					"対象エージェントの上限値はすでに変更されています",
				);
			}
			changeId = result.changeId;
			break;
		}
		case "resume_agent": {
			const result = await resumeAgent(db, {
				agentId: payload.agentId,
				actor,
				now: input.now,
			});
			if (!result.ok) {
				return fail("premise_changed", result.message);
			}
			changeId = result.changeId;
			break;
		}
	}

	const updateResult = await db
		.prepare(
			`UPDATE proposals
			SET status = 'approved', resolved_at = ?, resolved_by = ?, change_log_id = ?
			WHERE id = ? AND status = 'pending'`,
		)
		.bind(input.now, approverId, changeId, proposal.id)
		.run();
	if ((updateResult.meta.changes ?? 0) === 0) {
		return fail("already_resolved", "この提案はすでに処理されています");
	}

	const updated: Proposal = {
		...proposal,
		status: "approved",
		resolvedAt: input.now,
		resolvedBy: approverId,
		changeLogId: changeId,
	};
	return { ok: true, data: { proposal: updated, changeId } };
}

/** Rejects a pending proposal without modifying live rules, categories, or agents. */
export async function rejectProposal(
	db: D1Database,
	input: ResolveProposalInput,
): Promise<ProposalResult<{ proposal: Proposal }>> {
	if (!Number.isSafeInteger(input.now)) {
		return fail("invalid_input", "時刻は整数で指定してください");
	}
	if (
		typeof input.proposalId !== "string" ||
		input.proposalId.trim().length === 0
	) {
		return fail("invalid_input", "提案IDを指定してください");
	}
	if (
		typeof input.approverId !== "string" ||
		input.approverId.trim().length === 0
	) {
		return fail("invalid_input", "承認者IDを指定してください");
	}

	const approverId = input.approverId.trim();
	const row = await db
		.prepare("SELECT * FROM proposals WHERE id = ?")
		.bind(input.proposalId)
		.first<ProposalRow>();
	if (row === null) {
		return fail("not_found", "指定された提案が見つかりません");
	}

	const proposal = proposalFromRow(row);
	if (proposal.status === "expired") {
		return fail("expired", "この提案は有効期限（14日）を過ぎています");
	}
	if (proposal.status !== "pending") {
		return fail("already_resolved", "この提案はすでに処理されています");
	}
	if (proposal.expiresAt <= input.now) {
		await markProposalExpired(db, proposal.id, input.now);
		return fail("expired", "この提案は有効期限（14日）を過ぎています");
	}

	const updateResult = await db
		.prepare(
			`UPDATE proposals
			SET status = 'rejected', resolved_at = ?, resolved_by = ?
			WHERE id = ? AND status = 'pending'`,
		)
		.bind(input.now, approverId, proposal.id)
		.run();
	if ((updateResult.meta.changes ?? 0) === 0) {
		return fail("already_resolved", "この提案はすでに処理されています");
	}

	const updated: Proposal = {
		...proposal,
		status: "rejected",
		resolvedAt: input.now,
		resolvedBy: approverId,
	};
	return { ok: true, data: { proposal: updated } };
}

/**
 * Marks all overdue pending proposals (`expires_at <= now`) as `expired` and
 * returns the number of rows updated.
 */
export async function expireProposals(
	db: D1Database,
	now: UnixMillis,
): Promise<number> {
	if (!Number.isSafeInteger(now)) {
		throw new RangeError("now must be a safe integer");
	}
	const result = await db
		.prepare(
			`UPDATE proposals
			SET status = 'expired', resolved_at = ?
			WHERE status = 'pending' AND expires_at <= ?`,
		)
		.bind(now, now)
		.run();
	return result.meta.changes ?? 0;
}

/**
 * Generates the bridge's mechanical Japanese summary of what approving
 * `payload` will change (design 5.3). Reads strictly from `payload` and entity
 * name maps — never from the admin bot's free-text `reason`.
 */
export function describeProposalEffect(
	payload: ProposalPayload,
	names: ProposalEffectNames,
): string {
	switch (payload.kind) {
		case "grant_allow_rule": {
			const fromName =
				names.agents.get(payload.fromAgentId) ??
				`不明なエージェント (${payload.fromAgentId})`;
			const toName =
				names.agents.get(payload.toAgentId) ??
				`不明なエージェント (${payload.toAgentId})`;
			const categoryName =
				names.categories.get(payload.categoryId) ??
				`不明なカテゴリ (${payload.categoryId})`;
			return `許可ルールを追加: 「${fromName}」から「${toName}」へのカテゴリ「${categoryName}」の質問を許可します（一方向）`;
		}
		case "create_category":
			return `カテゴリを追加: 新しいカテゴリ「${payload.name}」を作成します（初期状態ではどのエージェント間にも許可されません）`;
		case "raise_daily_limit": {
			const agentName =
				names.agents.get(payload.agentId) ??
				`不明なエージェント (${payload.agentId})`;
			const currentLimit = names.agentLimits?.get(payload.agentId);
			if (currentLimit !== undefined) {
				return `1日の質問数上限を引き上げ: 「${agentName}」の上限を ${currentLimit} 件/日 から ${payload.newLimit} 件/日 に変更します`;
			}
			return `1日の質問数上限を引き上げ: 「${agentName}」の上限を ${payload.newLimit} 件/日 に変更します`;
		}
		case "resume_agent": {
			const agentName =
				names.agents.get(payload.agentId) ??
				`不明なエージェント (${payload.agentId})`;
			return `エージェントの停止を解除: 「${agentName}」の状態を suspended から active に戻し、接続と質問の送受信を再開します`;
		}
	}
}
