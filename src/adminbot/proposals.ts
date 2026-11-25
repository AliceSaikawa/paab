import { z } from "zod";
import {
	isUniqueConstraintError,
	validateId,
	validateName,
} from "../admin/validate";
import {
	type AgentRow,
	agentFromRow,
	type CategoryRow,
	newId,
	type ProposalRow,
	proposalFromRow,
} from "../db";
import { normalizeName } from "../policy";
import {
	type Agent,
	type AllowRule,
	type Category,
	type NewChangeLogEntry,
	PROPOSAL_STATUSES,
	type Proposal,
	type ProposalKind,
	type ProposalStatus,
	type UnixMillis,
} from "../types";

export const MAX_PENDING_PROPOSALS = 20;
export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const PROPOSAL_REASON_MAX_LENGTH = 2000;
export const DEFAULT_LIST_PROPOSALS_LIMIT = 100;
export const MAX_LIST_PROPOSALS_LIMIT = 200;

export interface GrantAllowRulePayload {
	fromAgentId: string;
	fromAgentName: string;
	toAgentId: string;
	toAgentName: string;
	categoryId: string;
	categoryName: string;
}

export interface CreateCategoryPayload {
	name: string;
}

export interface RaiseDailyLimitPayload {
	agentId: string;
	agentName: string;
	previousLimit: number;
	newLimit: number;
}

export interface ResumeAgentPayload {
	agentId: string;
	agentName: string;
}

export type ParsedProposal =
	| { kind: "grant_allow_rule"; payload: GrantAllowRulePayload }
	| { kind: "create_category"; payload: CreateCategoryPayload }
	| { kind: "raise_daily_limit"; payload: RaiseDailyLimitPayload }
	| { kind: "resume_agent"; payload: ResumeAgentPayload };

export type ProposalRequest =
	| {
			kind: "grant_allow_rule";
			fromAgentName: string;
			toAgentName: string;
			categoryName: string;
	  }
	| {
			kind: "create_category";
			name: string;
	  }
	| {
			kind: "raise_daily_limit";
			agentName: string;
			newLimit: number;
	  }
	| {
			kind: "resume_agent";
			agentName: string;
	  };

export interface CreateProposalInput {
	botAgentId: string;
	request: ProposalRequest;
	reason: string;
	now: UnixMillis;
}

export interface ResolveProposalInput {
	proposalId: string;
	approverEmail: string;
	now: UnixMillis;
}

export interface ProposalView extends Proposal {
	botAgentName: string;
}

export interface ListProposalsOptions {
	status?: ProposalStatus;
	limit?: number;
}

export type ProposalErrorCode =
	| "invalid_input"
	| "invalid_name"
	| "invalid_limit"
	| "invalid_payload"
	| "not_found"
	| "self_addressed"
	| "duplicate_rule"
	| "duplicate_name"
	| "already_active"
	| "too_many_pending"
	| "already_resolved"
	| "expired"
	| "conflict";

export interface ProposalFailure {
	ok: false;
	code: ProposalErrorCode;
	message: string;
	targetAgentId?: string;
}

export type ProposalResult<T> = { ok: true; data: T } | ProposalFailure;

export interface ApproveProposalData {
	proposal: Proposal;
	changeId: number;
}

export interface ExecuteLooseningAudit {
	toAgentId?: string;
	categoryId?: string;
}

export interface ExecuteLooseningData {
	kind: ProposalKind;
	changeId: number;
	effect: string;
	audit: ExecuteLooseningAudit;
}

const grantAllowRulePayloadSchema = z.object({
	fromAgentId: z.string().min(1),
	fromAgentName: z.string().min(1),
	toAgentId: z.string().min(1),
	toAgentName: z.string().min(1),
	categoryId: z.string().min(1),
	categoryName: z.string().min(1),
});

const createCategoryPayloadSchema = z.object({
	name: z.string().min(1),
});

const raiseDailyLimitPayloadSchema = z.object({
	agentId: z.string().min(1),
	agentName: z.string().min(1),
	previousLimit: z.number().int().min(0),
	newLimit: z.number().int().min(1),
});

const resumeAgentPayloadSchema = z.object({
	agentId: z.string().min(1),
	agentName: z.string().min(1),
});

function fail(code: ProposalErrorCode, message: string): ProposalFailure {
	return { ok: false, code, message };
}

function hasForbiddenReasonChar(text: string): boolean {
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (
			(code < 0x20 || (code >= 0x7f && code <= 0x9f)) &&
			ch !== "\n" &&
			ch !== "\t"
		) {
			return true;
		}
	}
	return false;
}

function validateReason(
	raw: string,
): { ok: true; value: string } | ProposalFailure {
	if (typeof raw !== "string") {
		return fail("invalid_input", "理由は文字列で指定してください");
	}
	const normalized = raw.replaceAll("\r\n", "\n").normalize("NFC").trim();
	if (normalized.length === 0) {
		return fail("invalid_input", "提案理由を入力してください");
	}
	if ([...normalized].length > PROPOSAL_REASON_MAX_LENGTH) {
		return fail(
			"invalid_input",
			`提案理由は${PROPOSAL_REASON_MAX_LENGTH}文字以内にしてください`,
		);
	}
	if (hasForbiddenReasonChar(normalized)) {
		return fail(
			"invalid_input",
			"提案理由に制御文字（改行とタブ以外）は使えません",
		);
	}
	return { ok: true, value: normalized };
}

function validateLookupName(
	raw: string,
	label: string,
): { ok: true; value: string } | ProposalFailure {
	if (typeof raw !== "string" || raw.includes("\0")) {
		return fail("invalid_input", `${label}が不正です`);
	}
	const normalized = normalizeName(raw);
	if (normalized.length === 0) {
		return fail("invalid_input", `${label}を指定してください`);
	}
	return { ok: true, value: normalized };
}

function validateApproverEmail(
	raw: string,
): { ok: true; value: string } | ProposalFailure {
	if (typeof raw !== "string" || raw.includes("\0")) {
		return fail("invalid_input", "承認者メールアドレスが不正です");
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return fail("invalid_input", "承認者メールアドレスを指定してください");
	}
	return { ok: true, value: trimmed };
}

/**
 * Parses and validates the JSON payload stored on a proposal row.
 */
export function parseProposalPayload(
	kind: ProposalKind,
	payloadJson: string,
): ParsedProposal | null {
	let raw: unknown;
	try {
		raw = JSON.parse(payloadJson);
	} catch {
		return null;
	}

	switch (kind) {
		case "grant_allow_rule": {
			const parsed = grantAllowRulePayloadSchema.safeParse(raw);
			return parsed.success ? { kind, payload: parsed.data } : null;
		}
		case "create_category": {
			const parsed = createCategoryPayloadSchema.safeParse(raw);
			return parsed.success ? { kind, payload: parsed.data } : null;
		}
		case "raise_daily_limit": {
			const parsed = raiseDailyLimitPayloadSchema.safeParse(raw);
			return parsed.success ? { kind, payload: parsed.data } : null;
		}
		case "resume_agent": {
			const parsed = resumeAgentPayloadSchema.safeParse(raw);
			return parsed.success ? { kind, payload: parsed.data } : null;
		}
	}
}

/**
 * Mechanically generates a Japanese summary of what approving `proposal`
 * changes, derived strictly from `proposal.kind` and `proposal.payloadJson`
 * (never reading `reason`).
 */
export function describeProposalEffect(
	proposal: Pick<Proposal, "kind" | "payloadJson">,
): string {
	const parsed = parseProposalPayload(proposal.kind, proposal.payloadJson);
	if (parsed === null) {
		return "（変更内容の解析に失敗しました）";
	}
	switch (parsed.kind) {
		case "grant_allow_rule":
			return `許可ルールを追加: ${parsed.payload.fromAgentName} → ${parsed.payload.toAgentName}（カテゴリ: ${parsed.payload.categoryName}）`;
		case "create_category":
			return `カテゴリを追加: 「${parsed.payload.name}」`;
		case "raise_daily_limit":
			return `1日あたりの質問数上限を引き上げ: ${parsed.payload.agentName}（${parsed.payload.previousLimit} → ${parsed.payload.newLimit}）`;
		case "resume_agent":
			return `停止中のエージェントを再開: ${parsed.payload.agentName}（suspended → active）`;
	}
}

type ValidationMode = "request" | "approve";

interface ApprovalGuard {
	proposalId: string;
	approverEmail: string;
}

interface MutationActor {
	actorId: string;
	approverId: string | null;
	now: UnixMillis;
}

interface PreparedMutationPlan {
	parsed: ParsedProposal;
	preconditionSql: string;
	preconditionBinds: (string | number)[];
	changeEntry: NewChangeLogEntry;
	mutationStatement: D1PreparedStatement;
	audit: ExecuteLooseningAudit;
}

function buildGrantAllowRulePlan(
	db: D1Database,
	rows: {
		fromRow: AgentRow | null;
		toRow: AgentRow | null;
		catRow: CategoryRow | null;
		ruleExists: boolean;
	},
	actor: MutationActor,
	mode: ValidationMode,
	approvalGuard?: ApprovalGuard,
): { ok: true; plan: PreparedMutationPlan } | ProposalFailure {
	if (rows.fromRow === null) {
		return fail(
			"not_found",
			mode === "approve"
				? "送信元エージェントが削除されているため承認できません"
				: "送信元エージェントが見つかりません",
		);
	}
	if (rows.toRow === null) {
		return fail(
			"not_found",
			mode === "approve"
				? "宛先エージェントが削除されているため承認できません"
				: "宛先エージェントが見つかりません",
		);
	}
	if (rows.catRow === null) {
		return fail(
			"not_found",
			mode === "approve"
				? "カテゴリが削除されているため承認できません"
				: "カテゴリが見つかりません",
		);
	}
	if (rows.fromRow.id === rows.toRow.id) {
		return fail(
			"self_addressed",
			mode === "approve"
				? "自分自身への質問を許可するルールは承認できません"
				: "自分自身への質問を許可するルールは提案できません",
		);
	}
	if (rows.ruleExists) {
		return fail(
			"duplicate_rule",
			mode === "approve"
				? "同じ許可ルールがすでに存在するため承認できません"
				: "同じ許可ルールがすでに存在します",
		);
	}

	const rule: AllowRule = {
		fromAgentId: rows.fromRow.id,
		toAgentId: rows.toRow.id,
		categoryId: rows.catRow.id,
		createdAt: actor.now,
	};
	const preconditionSql = [
		"EXISTS (SELECT 1 FROM agents WHERE id = ?)",
		"AND EXISTS (SELECT 1 FROM agents WHERE id = ?)",
		"AND EXISTS (SELECT 1 FROM categories WHERE id = ?)",
		"AND NOT EXISTS (SELECT 1 FROM allow_rules WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?)",
	].join(" ");
	const preconditionBinds = [
		rule.fromAgentId,
		rule.toAgentId,
		rule.categoryId,
		rule.fromAgentId,
		rule.toAgentId,
		rule.categoryId,
	];
	const guardSql =
		approvalGuard !== undefined
			? `EXISTS (
					SELECT 1 FROM proposals
					WHERE id = ? AND status = 'approved' AND resolved_at = ? AND resolved_by = ?
				) AND (${preconditionSql})`
			: preconditionSql;
	const guardBinds =
		approvalGuard !== undefined
			? [
					approvalGuard.proposalId,
					actor.now,
					approvalGuard.approverEmail,
					...preconditionBinds,
				]
			: preconditionBinds;

	return {
		ok: true,
		plan: {
			parsed: {
				kind: "grant_allow_rule",
				payload: {
					fromAgentId: rows.fromRow.id,
					fromAgentName: rows.fromRow.name,
					toAgentId: rows.toRow.id,
					toAgentName: rows.toRow.name,
					categoryId: rows.catRow.id,
					categoryName: rows.catRow.name,
				},
			},
			preconditionSql,
			preconditionBinds,
			changeEntry: {
				occurredAt: actor.now,
				actorType: "admin_bot",
				actorId: actor.actorId,
				approverId: actor.approverId,
				action: "allow_rule_granted",
				targetType: "allow_rule",
				targetId: `${rule.fromAgentId}:${rule.toAgentId}:${rule.categoryId}`,
				beforeJson: null,
				afterJson: JSON.stringify(rule),
				revertedAt: null,
			},
			mutationStatement: db
				.prepare(
					`INSERT INTO allow_rules (from_agent_id, to_agent_id, category_id, created_at)
					SELECT ?, ?, ?, ?
					WHERE ${guardSql}`,
				)
				.bind(
					rule.fromAgentId,
					rule.toAgentId,
					rule.categoryId,
					rule.createdAt,
					...guardBinds,
				),
			audit: {
				toAgentId: rule.toAgentId,
				categoryId: rule.categoryId,
			},
		},
	};
}

function buildCreateCategoryPlan(
	db: D1Database,
	name: string,
	existingCategoryId: string | null,
	actor: MutationActor,
	mode: ValidationMode,
	approvalGuard?: ApprovalGuard,
): { ok: true; plan: PreparedMutationPlan } | ProposalFailure {
	if (existingCategoryId !== null) {
		return fail(
			"duplicate_name",
			mode === "approve"
				? `カテゴリ「${name}」はすでに存在するため承認できません`
				: `カテゴリ「${name}」はすでに存在します`,
		);
	}

	const category: Category = { id: newId(), name };
	const preconditionSql =
		"NOT EXISTS (SELECT 1 FROM categories WHERE name = ?)";
	const preconditionBinds = [category.name];
	const guardSql =
		approvalGuard !== undefined
			? `EXISTS (
					SELECT 1 FROM proposals
					WHERE id = ? AND status = 'approved' AND resolved_at = ? AND resolved_by = ?
				) AND (${preconditionSql})`
			: preconditionSql;
	const guardBinds =
		approvalGuard !== undefined
			? [
					approvalGuard.proposalId,
					actor.now,
					approvalGuard.approverEmail,
					...preconditionBinds,
				]
			: preconditionBinds;

	return {
		ok: true,
		plan: {
			parsed: {
				kind: "create_category",
				payload: { name: category.name },
			},
			preconditionSql,
			preconditionBinds,
			changeEntry: {
				occurredAt: actor.now,
				actorType: "admin_bot",
				actorId: actor.actorId,
				approverId: actor.approverId,
				action: "category_created",
				targetType: "category",
				targetId: category.id,
				beforeJson: null,
				afterJson: JSON.stringify(category),
				revertedAt: null,
			},
			mutationStatement: db
				.prepare(
					`INSERT INTO categories (id, name)
					SELECT ?, ?
					WHERE ${guardSql}`,
				)
				.bind(category.id, category.name, ...guardBinds),
			audit: { categoryId: category.id },
		},
	};
}

function buildRaiseDailyLimitPlan(
	db: D1Database,
	agentRow: AgentRow | null,
	newLimit: number,
	actor: MutationActor,
	mode: ValidationMode,
	approvalGuard?: ApprovalGuard,
): { ok: true; plan: PreparedMutationPlan } | ProposalFailure {
	if (agentRow === null) {
		return fail(
			"not_found",
			mode === "approve"
				? "対象エージェントが削除されているため承認できません"
				: "指定されたエージェントが見つかりません",
		);
	}
	const current = agentFromRow(agentRow);
	if (!Number.isSafeInteger(newLimit) || newLimit < 1) {
		return {
			ok: false,
			code: "invalid_limit",
			message: "新しい1日あたりの質問数上限は1以上の整数で指定してください",
			targetAgentId: current.id,
		};
	}
	if (newLimit <= current.dailyQuestionLimit) {
		return {
			ok: false,
			code: "invalid_limit",
			message:
				mode === "approve"
					? `現在の上限（${current.dailyQuestionLimit}）が提案値（${newLimit}）以上のため承認できません`
					: `新しい上限（${newLimit}）は現在の上限（${current.dailyQuestionLimit}）より大きい値にしてください`,
			targetAgentId: current.id,
		};
	}

	const updated: Agent = { ...current, dailyQuestionLimit: newLimit };
	const preconditionSql =
		"EXISTS (SELECT 1 FROM agents WHERE id = ? AND daily_question_limit = ? AND daily_question_limit < ?)";
	const preconditionBinds = [current.id, current.dailyQuestionLimit, newLimit];
	const approvalFilter =
		approvalGuard !== undefined
			? ` AND EXISTS (
					SELECT 1 FROM proposals
					WHERE id = ? AND status = 'approved' AND resolved_at = ? AND resolved_by = ?
				)`
			: "";
	const approvalBinds =
		approvalGuard !== undefined
			? [approvalGuard.proposalId, actor.now, approvalGuard.approverEmail]
			: [];

	return {
		ok: true,
		plan: {
			parsed: {
				kind: "raise_daily_limit",
				payload: {
					agentId: current.id,
					agentName: current.name,
					previousLimit: current.dailyQuestionLimit,
					newLimit,
				},
			},
			preconditionSql,
			preconditionBinds,
			changeEntry: {
				occurredAt: actor.now,
				actorType: "admin_bot",
				actorId: actor.actorId,
				approverId: actor.approverId,
				action: "agent_updated",
				targetType: "agent",
				targetId: current.id,
				beforeJson: JSON.stringify(current),
				afterJson: JSON.stringify(updated),
				revertedAt: null,
			},
			mutationStatement: db
				.prepare(
					`UPDATE agents
					SET daily_question_limit = ?
					WHERE id = ? AND daily_question_limit = ? AND daily_question_limit < ?${approvalFilter}`,
				)
				.bind(
					newLimit,
					current.id,
					current.dailyQuestionLimit,
					newLimit,
					...approvalBinds,
				),
			audit: { toAgentId: current.id },
		},
	};
}

function buildResumeAgentPlan(
	db: D1Database,
	agentRow: AgentRow | null,
	actor: MutationActor,
	mode: ValidationMode,
	approvalGuard?: ApprovalGuard,
): { ok: true; plan: PreparedMutationPlan } | ProposalFailure {
	if (agentRow === null) {
		return fail(
			"not_found",
			mode === "approve"
				? "対象エージェントが削除されているため承認できません"
				: "指定されたエージェントが見つかりません",
		);
	}
	const current = agentFromRow(agentRow);
	if (current.status !== "suspended") {
		return fail(
			"already_active",
			mode === "approve"
				? `エージェント「${current.name}」はすでに有効なため承認できません`
				: `エージェント「${current.name}」は現在停止中ではありません`,
		);
	}

	const updated: Agent = { ...current, status: "active" };
	const preconditionSql =
		"EXISTS (SELECT 1 FROM agents WHERE id = ? AND status = 'suspended')";
	const preconditionBinds = [current.id];
	const approvalFilter =
		approvalGuard !== undefined
			? ` AND EXISTS (
					SELECT 1 FROM proposals
					WHERE id = ? AND status = 'approved' AND resolved_at = ? AND resolved_by = ?
				)`
			: "";
	const approvalBinds =
		approvalGuard !== undefined
			? [approvalGuard.proposalId, actor.now, approvalGuard.approverEmail]
			: [];

	return {
		ok: true,
		plan: {
			parsed: {
				kind: "resume_agent",
				payload: {
					agentId: current.id,
					agentName: current.name,
				},
			},
			preconditionSql,
			preconditionBinds,
			changeEntry: {
				occurredAt: actor.now,
				actorType: "admin_bot",
				actorId: actor.actorId,
				approverId: actor.approverId,
				action: "agent_resumed",
				targetType: "agent",
				targetId: current.id,
				beforeJson: JSON.stringify(current),
				afterJson: JSON.stringify(updated),
				revertedAt: null,
			},
			mutationStatement: db
				.prepare(
					`UPDATE agents
					SET status = 'active'
					WHERE id = ? AND status = 'suspended'${approvalFilter}`,
				)
				.bind(current.id, ...approvalBinds),
			audit: { toAgentId: current.id },
		},
	};
}

async function prepareRequestPlan(
	db: D1Database,
	request: ProposalRequest,
	actor: MutationActor,
): Promise<{ ok: true; plan: PreparedMutationPlan } | ProposalFailure> {
	switch (request.kind) {
		case "grant_allow_rule": {
			const fromName = validateLookupName(
				request.fromAgentName,
				"送信元エージェント名",
			);
			if (!fromName.ok) return fromName;
			const toName = validateLookupName(
				request.toAgentName,
				"宛先エージェント名",
			);
			if (!toName.ok) return toName;
			const catName = validateLookupName(request.categoryName, "カテゴリ名");
			if (!catName.ok) return catName;

			const [fromResult, toResult, catResult] = await db.batch([
				db.prepare("SELECT * FROM agents WHERE name = ?").bind(fromName.value),
				db.prepare("SELECT * FROM agents WHERE name = ?").bind(toName.value),
				db
					.prepare("SELECT * FROM categories WHERE name = ?")
					.bind(catName.value),
			]);
			const fromRow = (fromResult?.results[0] ?? null) as AgentRow | null;
			const toRow = (toResult?.results[0] ?? null) as AgentRow | null;
			const catRow = (catResult?.results[0] ?? null) as CategoryRow | null;
			const existingRule =
				fromRow !== null && toRow !== null && catRow !== null
					? await db
							.prepare(
								`SELECT 1 AS found FROM allow_rules
								WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
							)
							.bind(fromRow.id, toRow.id, catRow.id)
							.first<{ found: number }>()
					: null;

			return buildGrantAllowRulePlan(
				db,
				{
					fromRow,
					toRow,
					catRow,
					ruleExists: existingRule !== null,
				},
				actor,
				"request",
			);
		}

		case "create_category": {
			const name = validateName(request.name);
			if (!name.ok) {
				return fail(
					name.code === "invalid_name" ? "invalid_name" : "invalid_input",
					name.message,
				);
			}
			const existing = await db
				.prepare("SELECT id FROM categories WHERE name = ?")
				.bind(name.value)
				.first<{ id: string }>();
			return buildCreateCategoryPlan(
				db,
				name.value,
				existing?.id ?? null,
				actor,
				"request",
			);
		}

		case "raise_daily_limit": {
			const agentName = validateLookupName(request.agentName, "エージェント名");
			if (!agentName.ok) return agentName;
			const row = await db
				.prepare("SELECT * FROM agents WHERE name = ?")
				.bind(agentName.value)
				.first<AgentRow>();
			return buildRaiseDailyLimitPlan(
				db,
				row,
				request.newLimit,
				actor,
				"request",
			);
		}

		case "resume_agent": {
			const agentName = validateLookupName(request.agentName, "エージェント名");
			if (!agentName.ok) return agentName;
			const row = await db
				.prepare("SELECT * FROM agents WHERE name = ?")
				.bind(agentName.value)
				.first<AgentRow>();
			return buildResumeAgentPlan(db, row, actor, "request");
		}
	}
}

async function prepareStoredProposalPlan(
	db: D1Database,
	parsed: ParsedProposal,
	actor: MutationActor,
	approvalGuard: ApprovalGuard,
): Promise<{ ok: true; plan: PreparedMutationPlan } | ProposalFailure> {
	switch (parsed.kind) {
		case "grant_allow_rule": {
			const { fromAgentId, toAgentId, categoryId } = parsed.payload;
			const [fromResult, toResult, catResult, ruleResult] = await db.batch([
				db.prepare("SELECT * FROM agents WHERE id = ?").bind(fromAgentId),
				db.prepare("SELECT * FROM agents WHERE id = ?").bind(toAgentId),
				db.prepare("SELECT * FROM categories WHERE id = ?").bind(categoryId),
				db
					.prepare(
						`SELECT 1 AS found FROM allow_rules
						WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
					)
					.bind(fromAgentId, toAgentId, categoryId),
			]);
			return buildGrantAllowRulePlan(
				db,
				{
					fromRow: (fromResult?.results[0] ?? null) as AgentRow | null,
					toRow: (toResult?.results[0] ?? null) as AgentRow | null,
					catRow: (catResult?.results[0] ?? null) as CategoryRow | null,
					ruleExists: (ruleResult?.results.length ?? 0) > 0,
				},
				actor,
				"approve",
				approvalGuard,
			);
		}

		case "create_category": {
			const nameCheck = validateName(parsed.payload.name);
			if (!nameCheck.ok) {
				return fail("invalid_payload", nameCheck.message);
			}
			const existing = await db
				.prepare("SELECT id FROM categories WHERE name = ?")
				.bind(nameCheck.value)
				.first<{ id: string }>();
			return buildCreateCategoryPlan(
				db,
				nameCheck.value,
				existing?.id ?? null,
				actor,
				"approve",
				approvalGuard,
			);
		}

		case "raise_daily_limit": {
			const row = await db
				.prepare("SELECT * FROM agents WHERE id = ?")
				.bind(parsed.payload.agentId)
				.first<AgentRow>();
			return buildRaiseDailyLimitPlan(
				db,
				row,
				parsed.payload.newLimit,
				actor,
				"approve",
				approvalGuard,
			);
		}

		case "resume_agent": {
			const row = await db
				.prepare("SELECT * FROM agents WHERE id = ?")
				.bind(parsed.payload.agentId)
				.first<AgentRow>();
			return buildResumeAgentPlan(db, row, actor, "approve", approvalGuard);
		}
	}
}

function validateProposalInput(
	input: CreateProposalInput,
): { ok: true; botAgentId: string; reason: string } | ProposalFailure {
	if (!Number.isSafeInteger(input.now)) {
		return fail("invalid_input", "時刻は整数で指定してください");
	}
	const botIdCheck = validateId(input.botAgentId, "管理者ボットID");
	if (!botIdCheck.ok) {
		return fail("invalid_input", botIdCheck.message);
	}
	const reasonCheck = validateReason(input.reason);
	if (!reasonCheck.ok) return reasonCheck;
	return { ok: true, botAgentId: botIdCheck.value, reason: reasonCheck.value };
}

/**
 * Validates target constraints and pending proposal capacity, then inserts a
 * `pending` proposal expiring in 14 days without modifying any rules,
 * categories, or agents.
 */
export async function createProposal(
	db: D1Database,
	input: CreateProposalInput,
): Promise<ProposalResult<{ proposal: Proposal }>> {
	const validated = validateProposalInput(input);
	if (!validated.ok) return validated;

	const [botRowResult, countResult] = await db.batch([
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(validated.botAgentId),
		db
			.prepare(
				`SELECT COUNT(*) AS count
				FROM proposals
				WHERE status = 'pending' AND expires_at > ?`,
			)
			.bind(input.now),
	]);
	if ((botRowResult?.results.length ?? 0) === 0) {
		return fail("not_found", "管理者ボットが見つかりません");
	}
	const pendingCount = Number(
		(countResult?.results[0] as { count: number } | undefined)?.count ?? 0,
	);
	if (pendingCount >= MAX_PENDING_PROPOSALS) {
		return fail(
			"too_many_pending",
			`保留中の提案が上限（${MAX_PENDING_PROPOSALS}件）に達しているため、新しい提案を作成できません`,
		);
	}

	const prepared = await prepareRequestPlan(db, input.request, {
		actorId: validated.botAgentId,
		approverId: null,
		now: input.now,
	});
	if (!prepared.ok) return prepared;

	const proposal: Proposal = {
		id: newId(),
		botAgentId: validated.botAgentId,
		kind: prepared.plan.parsed.kind,
		payloadJson: JSON.stringify(prepared.plan.parsed.payload),
		reason: validated.reason,
		status: "pending",
		createdAt: input.now,
		expiresAt: input.now + PROPOSAL_TTL_MS,
		resolvedAt: null,
		resolvedBy: null,
	};

	// Re-check pending non-expired capacity inside the INSERT so concurrent calls
	// cannot exceed MAX_PENDING_PROPOSALS.
	const insertResult = await db
		.prepare(
			`INSERT INTO proposals
				(id, bot_agent_id, kind, payload_json, reason, status, created_at, expires_at, resolved_at, resolved_by)
			SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL
			WHERE (
				SELECT COUNT(*) FROM proposals
				WHERE status = 'pending' AND expires_at > ?
			) < ?`,
		)
		.bind(
			proposal.id,
			proposal.botAgentId,
			proposal.kind,
			proposal.payloadJson,
			proposal.reason,
			proposal.createdAt,
			proposal.expiresAt,
			input.now,
			MAX_PENDING_PROPOSALS,
		)
		.run();

	if (insertResult.meta.changes !== 1) {
		return fail(
			"too_many_pending",
			`保留中の提案が上限（${MAX_PENDING_PROPOSALS}件）に達しているため、新しい提案を作成できません`,
		);
	}

	return { ok: true, data: { proposal } };
}

function buildChangeLogInsert(
	db: D1Database,
	plan: PreparedMutationPlan,
	whereSql: string,
	whereBinds: (string | number)[],
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO change_log
				(occurred_at, actor_type, actor_id, approver_id, action,
				target_type, target_id, before_json, after_json, reverted_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE ${whereSql}`,
		)
		.bind(
			plan.changeEntry.occurredAt,
			plan.changeEntry.actorType,
			plan.changeEntry.actorId,
			plan.changeEntry.approverId,
			plan.changeEntry.action,
			plan.changeEntry.targetType,
			plan.changeEntry.targetId,
			plan.changeEntry.beforeJson,
			plan.changeEntry.afterJson,
			plan.changeEntry.revertedAt,
			...whereBinds,
		);
}

/**
 * Executes a loosening operation immediately on behalf of the admin bot while
 * `superadmin` is active, recording `actor_type = 'admin_bot'` and
 * `approver_id = NULL` in `change_log` without creating a proposal.
 */
export async function executeAdminBotLoosening(
	db: D1Database,
	input: CreateProposalInput,
): Promise<ProposalResult<ExecuteLooseningData>> {
	const validated = validateProposalInput(input);
	if (!validated.ok) return validated;

	const botRow = await db
		.prepare("SELECT id FROM agents WHERE id = ?")
		.bind(validated.botAgentId)
		.first<{ id: string }>();
	if (botRow === null) {
		return fail("not_found", "管理者ボットが見つかりません");
	}

	const prepared = await prepareRequestPlan(db, input.request, {
		actorId: validated.botAgentId,
		approverId: null,
		now: input.now,
	});
	if (!prepared.ok) return prepared;

	const { plan } = prepared;
	let results: D1Result[];
	try {
		results = await db.batch([
			buildChangeLogInsert(
				db,
				plan,
				plan.preconditionSql,
				plan.preconditionBinds,
			),
			plan.mutationStatement,
		]);
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			return fail(
				"conflict",
				"対象の状態が競合して変更されたため実行できませんでした",
			);
		}
		throw error;
	}

	if (results[1]?.meta.changes !== 1) {
		return fail(
			"conflict",
			"前提条件が変更されたため実行できませんでした。最新の状態を確認してください",
		);
	}
	const changeId = Number(results[0]?.meta.last_row_id);
	if (!Number.isSafeInteger(changeId) || changeId <= 0) {
		throw new Error("change_log insert did not return a valid last_row_id");
	}

	return {
		ok: true,
		data: {
			kind: plan.parsed.kind,
			changeId,
			effect: describeProposalEffect({
				kind: plan.parsed.kind,
				payloadJson: JSON.stringify(plan.parsed.payload),
			}),
			audit: plan.audit,
		},
	};
}

function failureForNonPending(status: ProposalStatus): ProposalFailure {
	switch (status) {
		case "approved":
			return fail("already_resolved", "この提案はすでに承認済みです");
		case "rejected":
			return fail("already_resolved", "この提案はすでに却下済みです");
		case "expired":
			return fail(
				"expired",
				"この提案は有効期限（14日）を過ぎたため操作できません",
			);
		case "pending":
			return fail("conflict", "提案の状態が変更されました");
	}
}

async function executeApprovalBatch(
	db: D1Database,
	proposalId: string,
	approverEmail: string,
	now: UnixMillis,
	plan: PreparedMutationPlan,
): Promise<{ applied: true; changeId: number } | { applied: false }> {
	const results = await db.batch([
		buildChangeLogInsert(
			db,
			plan,
			`EXISTS (
				SELECT 1 FROM proposals
				WHERE id = ? AND status = 'pending' AND expires_at > ?
			) AND (${plan.preconditionSql})`,
			[proposalId, now, ...plan.preconditionBinds],
		),
		db
			.prepare(
				`UPDATE proposals
				SET status = 'approved', resolved_at = ?, resolved_by = ?
				WHERE id = ? AND status = 'pending' AND expires_at > ?
					AND (${plan.preconditionSql})`,
			)
			.bind(now, approverEmail, proposalId, now, ...plan.preconditionBinds),
		plan.mutationStatement,
	]);

	if (results[1]?.meta.changes !== 1) {
		return { applied: false };
	}
	const changeId = Number(results[0]?.meta.last_row_id);
	if (!Number.isSafeInteger(changeId) || changeId <= 0) {
		throw new Error("change_log insert did not return a valid last_row_id");
	}
	return { applied: true, changeId };
}

/**
 * Approves a pending proposal if it has not expired and all preconditions still
 * hold, atomically applying the change, inserting a `change_log` row with both
 * `admin_bot` and `approver_id`, and marking the proposal `approved`.
 */
export async function approveProposal(
	db: D1Database,
	input: ResolveProposalInput,
): Promise<ProposalResult<ApproveProposalData>> {
	if (!Number.isSafeInteger(input.now)) {
		return fail("invalid_input", "時刻は整数で指定してください");
	}
	const idCheck = validateId(input.proposalId, "提案ID");
	if (!idCheck.ok) {
		return fail("invalid_input", idCheck.message);
	}
	const approverCheck = validateApproverEmail(input.approverEmail);
	if (!approverCheck.ok) return approverCheck;

	const row = await db
		.prepare("SELECT * FROM proposals WHERE id = ?")
		.bind(idCheck.value)
		.first<ProposalRow>();
	if (row === null) {
		return fail("not_found", "指定された提案が見つかりません");
	}
	const proposal = proposalFromRow(row);
	if (proposal.status !== "pending") {
		return failureForNonPending(proposal.status);
	}

	if (input.now >= proposal.expiresAt) {
		await db
			.prepare(
				`UPDATE proposals
				SET status = 'expired', resolved_at = ?
				WHERE id = ? AND status = 'pending'`,
			)
			.bind(input.now, proposal.id)
			.run();
		return fail(
			"expired",
			"この提案は有効期限（14日）を過ぎたため期限切れになりました",
		);
	}

	const parsed = parseProposalPayload(proposal.kind, proposal.payloadJson);
	if (parsed === null) {
		return fail("invalid_payload", "提案の内容が不正なため承認できません");
	}

	const planResult = await prepareStoredProposalPlan(
		db,
		parsed,
		{
			actorId: proposal.botAgentId,
			approverId: approverCheck.value,
			now: input.now,
		},
		{
			proposalId: proposal.id,
			approverEmail: approverCheck.value,
		},
	);
	if (!planResult.ok) return planResult;

	let batchResult: { applied: true; changeId: number } | { applied: false };
	try {
		batchResult = await executeApprovalBatch(
			db,
			proposal.id,
			approverCheck.value,
			input.now,
			planResult.plan,
		);
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			return fail(
				"conflict",
				"対象の状態が競合して変更されたため承認できませんでした",
			);
		}
		throw error;
	}

	if (!batchResult.applied) {
		const latestRow = await db
			.prepare("SELECT * FROM proposals WHERE id = ?")
			.bind(proposal.id)
			.first<ProposalRow>();
		if (latestRow === null) {
			return fail("not_found", "指定された提案が見つかりません");
		}
		const latest = proposalFromRow(latestRow);
		if (latest.status !== "pending") {
			return failureForNonPending(latest.status);
		}
		return fail(
			"conflict",
			"前提条件が変更されたため承認できませんでした。最新の状態を確認してください",
		);
	}

	return {
		ok: true,
		data: {
			proposal: {
				...proposal,
				status: "approved",
				resolvedAt: input.now,
				resolvedBy: approverCheck.value,
			},
			changeId: batchResult.changeId,
		},
	};
}

/**
 * Marks a `pending` (non-expired) proposal as `rejected`.
 */
export async function rejectProposal(
	db: D1Database,
	input: ResolveProposalInput,
): Promise<ProposalResult<{ proposal: Proposal }>> {
	if (!Number.isSafeInteger(input.now)) {
		return fail("invalid_input", "時刻は整数で指定してください");
	}
	const idCheck = validateId(input.proposalId, "提案ID");
	if (!idCheck.ok) {
		return fail("invalid_input", idCheck.message);
	}
	const approverCheck = validateApproverEmail(input.approverEmail);
	if (!approverCheck.ok) return approverCheck;

	const row = await db
		.prepare("SELECT * FROM proposals WHERE id = ?")
		.bind(idCheck.value)
		.first<ProposalRow>();
	if (row === null) {
		return fail("not_found", "指定された提案が見つかりません");
	}
	const proposal = proposalFromRow(row);
	if (proposal.status !== "pending") {
		return failureForNonPending(proposal.status);
	}

	if (input.now >= proposal.expiresAt) {
		await db
			.prepare(
				`UPDATE proposals
				SET status = 'expired', resolved_at = ?
				WHERE id = ? AND status = 'pending'`,
			)
			.bind(input.now, proposal.id)
			.run();
		return fail(
			"expired",
			"この提案は有効期限（14日）を過ぎたため期限切れになりました",
		);
	}

	const result = await db
		.prepare(
			`UPDATE proposals
			SET status = 'rejected', resolved_at = ?, resolved_by = ?
			WHERE id = ? AND status = 'pending' AND expires_at > ?`,
		)
		.bind(input.now, approverCheck.value, proposal.id, input.now)
		.run();

	if (result.meta.changes !== 1) {
		const latestRow = await db
			.prepare("SELECT * FROM proposals WHERE id = ?")
			.bind(proposal.id)
			.first<ProposalRow>();
		if (latestRow === null) {
			return fail("not_found", "指定された提案が見つかりません");
		}
		return failureForNonPending(proposalFromRow(latestRow).status);
	}

	return {
		ok: true,
		data: {
			proposal: {
				...proposal,
				status: "rejected",
				resolvedAt: input.now,
				resolvedBy: approverCheck.value,
			},
		},
	};
}

/**
 * Expires all `pending` proposals whose `expires_at <= now`. Idempotent across
 * repeated runs.
 */
export async function expireOverdueProposals(
	db: D1Database,
	now: UnixMillis,
): Promise<number> {
	if (!Number.isSafeInteger(now)) {
		throw new RangeError("now must be an integer of UNIX milliseconds");
	}
	const result = await db
		.prepare(
			`UPDATE proposals
			SET status = 'expired', resolved_at = ?
			WHERE status = 'pending' AND expires_at <= ?`,
		)
		.bind(now, now)
		.run();
	return result.meta.changes;
}

interface ProposalJoinRow extends ProposalRow {
	bot_agent_name: string;
}

/**
 * Lists proposals ordered newest-first, optionally filtered by status.
 */
export async function listProposals(
	db: D1Database,
	options: ListProposalsOptions = {},
): Promise<ProposalView[]> {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (options.status !== undefined) {
		if (!(PROPOSAL_STATUSES as readonly string[]).includes(options.status)) {
			throw new RangeError(
				`status must be one of: ${PROPOSAL_STATUSES.join(", ")}`,
			);
		}
		where.push("p.status = ?");
		params.push(options.status);
	}
	const limit = options.limit ?? DEFAULT_LIST_PROPOSALS_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError("limit must be a positive integer");
	}
	params.push(Math.min(limit, MAX_LIST_PROPOSALS_LIMIT));

	const sql = [
		"SELECT p.*, a.name AS bot_agent_name",
		"FROM proposals p",
		"JOIN agents a ON a.id = p.bot_agent_id",
		...(where.length > 0 ? [`WHERE ${where.join(" AND ")}`] : []),
		"ORDER BY p.created_at DESC, p.id DESC",
		"LIMIT ?",
	].join(" ");

	const { results } = await db
		.prepare(sql)
		.bind(...params)
		.all<ProposalJoinRow>();

	return results.map((row) => ({
		...proposalFromRow(row),
		botAgentName: row.bot_agent_name,
	}));
}
