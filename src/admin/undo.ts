import {
	type AgentRow,
	agentFromRow,
	type ChangeLogRow,
	changeLogEntryFromRow,
	insertAllowRule,
} from "../db";
import {
	AGENT_STATUSES,
	type AgentStatus,
	type ChangeAction,
	type ChangeLogEntry,
	type ChangeTargetType,
	type UnixMillis,
} from "../types";
import { queryChangeLog } from "./query";
import type { AdminErrorCode, ChangeActor } from "./types";
import {
	isUniqueConstraintError,
	runWithChangeLog,
	validateContext,
	validateDailyLimit,
	validateDescription,
	validateName,
} from "./validate";

export const UNDOABLE_CHANGE_ACTIONS = [
	"agent_suspended",
	"agent_resumed",
	"agent_updated",
	"allow_rule_revoked",
	"allow_rule_granted",
	"category_created",
] as const satisfies readonly ChangeAction[];

export type UndoableChangeAction = (typeof UNDOABLE_CHANGE_ACTIONS)[number];

export type UndoErrorCode =
	| AdminErrorCode
	| "already_reverted"
	| "conflict_newer_change"
	| "not_undoable";

export interface UndoFailure {
	ok: false;
	code: UndoErrorCode;
	message: string;
}

export type UndoResult<T> =
	| { ok: true; data: T; changeId: number }
	| UndoFailure;

export interface RevertAdminBotChangeInput {
	changeId: number;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface RevertedChangeSummary {
	revertedChangeId: number;
	action: UndoableChangeAction;
	targetType: ChangeTargetType;
	targetId: string;
}

function undoFail(code: UndoErrorCode, message: string): UndoFailure {
	return { ok: false, code, message };
}

/** Returns whether `action` can be reverted by `revertAdminBotChange`. */
export function isUndoableChangeAction(
	action: ChangeAction,
): action is UndoableChangeAction {
	return (UNDOABLE_CHANGE_ACTIONS as readonly string[]).includes(action);
}

/** Lists `change_log` entries performed by `admin_bot`, newest first. */
export async function listAdminBotChanges(
	db: D1Database,
	limit?: number,
): Promise<ChangeLogEntry[]> {
	return queryChangeLog(db, { actorType: "admin_bot", limit });
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function readNonEmptyString(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseAllowRuleSnapshot(raw: string | null): {
	fromAgentId: string;
	toAgentId: string;
	categoryId: string;
	createdAt: number | null;
} | null {
	const record = parseJsonRecord(raw);
	if (record === null) return null;
	const fromAgentId = readNonEmptyString(record, "fromAgentId");
	const toAgentId = readNonEmptyString(record, "toAgentId");
	const categoryId = readNonEmptyString(record, "categoryId");
	if (fromAgentId === null || toAgentId === null || categoryId === null) {
		return null;
	}
	const createdAt =
		typeof record.createdAt === "number" &&
		Number.isSafeInteger(record.createdAt)
			? record.createdAt
			: null;
	return { fromAgentId, toAgentId, categoryId, createdAt };
}

function newerTargetChangeQuery(
	db: D1Database,
	targetType: ChangeTargetType,
	targetId: string,
	afterChangeId: number,
): D1PreparedStatement {
	return db
		.prepare(
			`SELECT id FROM change_log
			WHERE target_type = ? AND target_id = ? AND id > ?
				AND reverted_at IS NULL AND action <> 'change_reverted'
			LIMIT 1`,
		)
		.bind(targetType, targetId, afterChangeId);
}

type PreparedRestore =
	| { ok: true; statement: D1PreparedStatement }
	| UndoFailure;

async function prepareAgentRestore(
	db: D1Database,
	entry: ChangeLogEntry,
): Promise<PreparedRestore> {
	const snapshot = parseJsonRecord(entry.beforeJson);
	if (snapshot === null) {
		return undoFail("invalid_input", "変更前スナップショットが不正です");
	}

	const [conflictResult, agentResult] = await db.batch([
		newerTargetChangeQuery(db, "agent", entry.targetId, entry.id),
		db.prepare("SELECT * FROM agents WHERE id = ?").bind(entry.targetId),
	]);
	if ((conflictResult?.results.length ?? 0) > 0) {
		return undoFail(
			"conflict_newer_change",
			"対象エージェントに新しい変更があるため元に戻せません",
		);
	}
	const agentRow = (agentResult?.results[0] ?? null) as AgentRow | null;
	if (agentRow === null) {
		return undoFail("not_found", "対象のエージェントが見つかりません");
	}
	const current = agentFromRow(agentRow);

	if (entry.action === "agent_suspended" || entry.action === "agent_resumed") {
		const rawStatus = snapshot.status;
		if (
			typeof rawStatus !== "string" ||
			!(AGENT_STATUSES as readonly string[]).includes(rawStatus)
		) {
			return undoFail("invalid_input", "変更前のエージェント状態が不正です");
		}
		const prevStatus = rawStatus as AgentStatus;
		return {
			ok: true,
			statement: db
				.prepare("UPDATE agents SET status = ? WHERE id = ?")
				.bind(prevStatus, current.id),
		};
	}

	const rawLimit = snapshot.dailyQuestionLimit;
	const rawDescription = snapshot.description;
	if (typeof rawLimit !== "number" || typeof rawDescription !== "string") {
		return undoFail("invalid_input", "変更前のエージェント設定が不正です");
	}
	const limitCheck = validateDailyLimit(rawLimit);
	if (!limitCheck.ok) {
		return undoFail("invalid_input", limitCheck.message);
	}

	const nextDescription =
		rawDescription === current.description
			? current.description
			: (() => {
					const check = validateDescription(rawDescription);
					return check.ok ? check.value : null;
				})();
	if (nextDescription === null) {
		return undoFail("invalid_input", "変更前の説明文が不正です");
	}

	let nextName = current.name;
	if (snapshot.name !== undefined) {
		if (typeof snapshot.name !== "string") {
			return undoFail("invalid_input", "変更前のエージェント名が不正です");
		}
		if (snapshot.name !== current.name) {
			const nameCheck = validateName(snapshot.name);
			if (!nameCheck.ok) {
				return undoFail("invalid_input", nameCheck.message);
			}
			nextName = nameCheck.value;
			const duplicate = await db
				.prepare("SELECT id FROM agents WHERE name = ? AND id <> ?")
				.bind(nextName, current.id)
				.first<{ id: string }>();
			if (duplicate !== null) {
				return undoFail(
					"duplicate_name",
					`エージェント「${nextName}」はすでに別のエージェントで使われています`,
				);
			}
		}
	}

	return {
		ok: true,
		statement: db
			.prepare(
				"UPDATE agents SET name = ?, description = ?, daily_question_limit = ? WHERE id = ?",
			)
			.bind(nextName, nextDescription, limitCheck.value, current.id),
	};
}

async function prepareAllowRuleRestore(
	db: D1Database,
	entry: ChangeLogEntry,
	now: UnixMillis,
): Promise<PreparedRestore> {
	const rawSnapshot =
		entry.action === "allow_rule_revoked" ? entry.beforeJson : entry.afterJson;
	const rule = parseAllowRuleSnapshot(rawSnapshot);
	if (
		rule === null ||
		rule.fromAgentId === rule.toAgentId ||
		`${rule.fromAgentId}:${rule.toAgentId}:${rule.categoryId}` !==
			entry.targetId
	) {
		return undoFail("invalid_input", "許可ルールのスナップショットが不正です");
	}

	const [
		ruleConflict,
		dependencyConflict,
		fromAgent,
		toAgent,
		category,
		existingRule,
	] = await db.batch([
		newerTargetChangeQuery(db, "allow_rule", entry.targetId, entry.id),
		db
			.prepare(
				`SELECT id FROM change_log
				WHERE id > ? AND reverted_at IS NULL
					AND (
						(target_type = 'agent' AND target_id IN (?, ?) AND action = 'agent_deleted')
						OR (target_type = 'category' AND target_id = ? AND action = 'category_deleted')
					)
				LIMIT 1`,
			)
			.bind(entry.id, rule.fromAgentId, rule.toAgentId, rule.categoryId),
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(rule.fromAgentId),
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(rule.toAgentId),
		db.prepare("SELECT id FROM categories WHERE id = ?").bind(rule.categoryId),
		db
			.prepare(
				`SELECT 1 AS found FROM allow_rules
				WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
			)
			.bind(rule.fromAgentId, rule.toAgentId, rule.categoryId),
	]);

	if (
		(ruleConflict?.results.length ?? 0) > 0 ||
		(dependencyConflict?.results.length ?? 0) > 0
	) {
		return undoFail(
			"conflict_newer_change",
			"許可ルールまたは対象エージェント・カテゴリに新しい変更があるため元に戻せません",
		);
	}

	if (
		(fromAgent?.results.length ?? 0) === 0 ||
		(toAgent?.results.length ?? 0) === 0 ||
		(category?.results.length ?? 0) === 0
	) {
		return undoFail(
			"not_found",
			"許可ルールが参照するエージェントまたはカテゴリが見つかりません",
		);
	}

	const ruleExists = (existingRule?.results.length ?? 0) > 0;
	if (entry.action === "allow_rule_revoked") {
		if (ruleExists) {
			return undoFail("duplicate_rule", "同じ許可ルールがすでに存在します");
		}
		return {
			ok: true,
			statement: insertAllowRule(db, {
				fromAgentId: rule.fromAgentId,
				toAgentId: rule.toAgentId,
				categoryId: rule.categoryId,
				createdAt: rule.createdAt ?? now,
			}),
		};
	}

	if (!ruleExists) {
		return undoFail("not_found", "対象の許可ルールが見つかりません");
	}
	return {
		ok: true,
		statement: db
			.prepare(
				`DELETE FROM allow_rules
				WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
			)
			.bind(rule.fromAgentId, rule.toAgentId, rule.categoryId),
	};
}

async function prepareCategoryRestore(
	db: D1Database,
	entry: ChangeLogEntry,
): Promise<PreparedRestore> {
	const snapshot = parseJsonRecord(entry.afterJson);
	const categoryId =
		snapshot !== null ? readNonEmptyString(snapshot, "id") : null;
	if (categoryId === null || categoryId !== entry.targetId) {
		return undoFail("invalid_input", "カテゴリのスナップショットが不正です");
	}

	const [catConflict, ruleChanges, existingRule, categoryRow] = await db.batch([
		newerTargetChangeQuery(db, "category", entry.targetId, entry.id),
		db
			.prepare(
				`SELECT id, target_id FROM change_log
				WHERE target_type = 'allow_rule' AND id > ?
					AND reverted_at IS NULL AND action <> 'change_reverted'`,
			)
			.bind(entry.id),
		db
			.prepare(
				"SELECT 1 AS found FROM allow_rules WHERE category_id = ? LIMIT 1",
			)
			.bind(categoryId),
		db.prepare("SELECT id FROM categories WHERE id = ?").bind(categoryId),
	]);

	const hasDependentRuleChange = (
		(ruleChanges?.results ?? []) as Array<{ id: number; target_id: string }>
	).some((row) => row.target_id.endsWith(`:${categoryId}`));
	if (
		(catConflict?.results.length ?? 0) > 0 ||
		hasDependentRuleChange ||
		(existingRule?.results.length ?? 0) > 0
	) {
		return undoFail(
			"conflict_newer_change",
			"対象カテゴリに新しい変更または使用中の許可ルールがあるため元に戻せません",
		);
	}

	if ((categoryRow?.results.length ?? 0) === 0) {
		return undoFail("not_found", "対象のカテゴリが見つかりません");
	}

	return {
		ok: true,
		statement: db
			.prepare("DELETE FROM categories WHERE id = ?")
			.bind(categoryId),
	};
}

/**
 * Reverts one non-reverted `admin_bot` change atomically and records a
 * `"change_reverted"` entry in `change_log`.
 */
export async function revertAdminBotChange(
	db: D1Database,
	input: RevertAdminBotChangeInput,
): Promise<UndoResult<RevertedChangeSummary>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;
	if (ctx.value.actorType !== "owner") {
		return undoFail(
			"invalid_input",
			"変更の取り消しは所有者のみが実行できます",
		);
	}
	if (!Number.isSafeInteger(input.changeId) || input.changeId <= 0) {
		return undoFail("invalid_input", "変更IDは正の整数で指定してください");
	}

	const rawRow = await db
		.prepare("SELECT * FROM change_log WHERE id = ?")
		.bind(input.changeId)
		.first<ChangeLogRow>();
	if (rawRow === null) {
		return undoFail("not_found", "指定された変更履歴が見つかりません");
	}
	const entry = changeLogEntryFromRow(rawRow);

	if (entry.actorType !== "admin_bot") {
		return undoFail("invalid_input", "管理者ボットによる変更のみ元に戻せます");
	}
	if (entry.revertedAt !== null) {
		return undoFail("already_reverted", "この変更はすでに元に戻されています");
	}
	if (!isUndoableChangeAction(entry.action)) {
		return undoFail("not_undoable", "この種類の変更は元に戻せません");
	}

	let prepared: PreparedRestore;
	switch (entry.action) {
		case "agent_suspended":
		case "agent_resumed":
		case "agent_updated":
			prepared = await prepareAgentRestore(db, entry);
			break;
		case "allow_rule_revoked":
		case "allow_rule_granted":
			prepared = await prepareAllowRuleRestore(db, entry, ctx.value.now);
			break;
		case "category_created":
			prepared = await prepareCategoryRestore(db, entry);
			break;
	}
	if (!prepared.ok) {
		return prepared;
	}

	try {
		const changeId = await runWithChangeLog(
			db,
			[
				prepared.statement,
				db
					.prepare(
						"UPDATE change_log SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL",
					)
					.bind(ctx.value.now, entry.id),
			],
			{
				occurredAt: ctx.value.now,
				actorType: "owner",
				actorId: ctx.value.actorId,
				approverId: ctx.value.approverId,
				action: "change_reverted",
				targetType: entry.targetType,
				targetId: entry.targetId,
				beforeJson: entry.afterJson,
				afterJson: entry.beforeJson,
				revertedAt: null,
			},
		);

		return {
			ok: true,
			data: {
				revertedChangeId: entry.id,
				action: entry.action,
				targetType: entry.targetType,
				targetId: entry.targetId,
			},
			changeId,
		};
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			return undoFail(
				"conflict_newer_change",
				"競合する変更が発生したため元に戻せませんでした",
			);
		}
		throw error;
	}
}
