import {
	type AgentRow,
	agentFromRow,
	type ChangeLogRow,
	changeLogEntryFromRow,
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
	"description_approved",
] as const satisfies readonly ChangeAction[];

export type UndoableChangeAction = (typeof UNDOABLE_CHANGE_ACTIONS)[number];

export type AgentField =
	| "status"
	| "name"
	| "description"
	| "dailyQuestionLimit";

const ALL_AGENT_FIELDS: readonly AgentField[] = [
	"status",
	"name",
	"description",
	"dailyQuestionLimit",
];

const AGENT_UPDATE_FIELDS = [
	"name",
	"description",
	"dailyQuestionLimit",
] as const satisfies readonly AgentField[];

const EMPTY_AGENT_FIELDS: ReadonlySet<AgentField> = new Set();

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

/**
 * Returns the set of `agents` columns mutated by `entry`.
 *
 * Used for field-scoped conflict detection and targeted `UPDATE` generation so
 * unrelated mutations (such as webhook changes or approving a description)
 * never lock out or get clobbered by reverting another field.
 */
export function changedAgentFields(
	entry: ChangeLogEntry,
): ReadonlySet<AgentField> {
	switch (entry.action) {
		case "agent_suspended":
		case "agent_resumed":
			return new Set<AgentField>(["status"]);
		case "agent_deleted":
			return new Set<AgentField>(ALL_AGENT_FIELDS);
		case "agent_updated": {
			const before = parseJsonRecord(entry.beforeJson);
			const after = parseJsonRecord(entry.afterJson);
			if (before === null && after === null) {
				return new Set<AgentField>(AGENT_UPDATE_FIELDS);
			}
			const changed = new Set<AgentField>();
			if (before === null || after === null) {
				const present = before ?? after;
				for (const field of AGENT_UPDATE_FIELDS) {
					if (present !== null && present[field] !== undefined) {
						changed.add(field);
					}
				}
				return changed;
			}
			for (const field of AGENT_UPDATE_FIELDS) {
				if (before[field] !== after[field]) {
					changed.add(field);
				}
			}
			return changed;
		}
		case "description_approved":
			return new Set<AgentField>(["description"]);
		case "agent_registered":
		case "token_issued":
		case "token_revoked":
		case "category_created":
		case "category_deleted":
		case "allow_rule_granted":
		case "allow_rule_revoked":
		case "admin_bot_designated":
		case "admin_bot_cleared":
		case "admin_bot_switches_updated":
		case "description_rejected":
		case "webhook_configured":
		case "webhook_secret_rotated":
		case "webhook_deleted":
		case "change_reverted":
			return EMPTY_AGENT_FIELDS;
	}
}

function setsIntersect<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
	for (const value of a) {
		if (b.has(value)) return true;
	}
	return false;
}

function newerAgentRelatedChangesQuery(
	db: D1Database,
	agentId: string,
	afterChangeId: number,
): D1PreparedStatement {
	return db
		.prepare(
			`SELECT * FROM change_log
			WHERE target_type IN ('agent', 'description') AND target_id = ? AND id > ?
				AND reverted_at IS NULL AND action <> 'change_reverted'
			ORDER BY id ASC`,
		)
		.bind(agentId, afterChangeId);
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

interface SqlCondition {
	sql: string;
	binds: unknown[];
}

type PreparedRestore =
	| {
			ok: true;
			precondition: SqlCondition;
			buildStatements: (
				claimSql: string,
				claimTag: number,
			) => {
				restore: D1PreparedStatement;
				extras?: D1PreparedStatement[];
			};
	  }
	| UndoFailure;

const REVERT_CLAIM_SQL =
	"EXISTS (SELECT 1 FROM change_log WHERE action = 'change_reverted' AND reverted_at = ?)";

function newerAgentConflictCondition(
	agentId: string,
	afterChangeId: number,
	fieldsToRestore: ReadonlySet<AgentField>,
): SqlCondition {
	const actionClauses: string[] = ["action = 'agent_deleted'"];
	if (fieldsToRestore.has("status")) {
		actionClauses.push("action IN ('agent_suspended', 'agent_resumed')");
	}
	if (fieldsToRestore.has("description")) {
		actionClauses.push("action = 'description_approved'");
	}
	const updateFields = AGENT_UPDATE_FIELDS.filter((field) =>
		fieldsToRestore.has(field),
	);
	if (updateFields.length > 0) {
		const fieldDiffs = updateFields
			.map(
				(field) =>
					`json_extract(before_json, '$.${field}') IS NOT json_extract(after_json, '$.${field}')`,
			)
			.join(" OR ");
		actionClauses.push(
			`(action = 'agent_updated' AND (CASE
				WHEN before_json IS NULL OR after_json IS NULL
					OR NOT json_valid(before_json) OR NOT json_valid(after_json)
				THEN 1
				WHEN json_type(before_json) <> 'object' OR json_type(after_json) <> 'object'
				THEN 1
				WHEN ${fieldDiffs}
				THEN 1
				ELSE 0
			END) = 1)`,
		);
	}
	return {
		sql: `NOT EXISTS (
			SELECT 1 FROM change_log
			WHERE target_type IN ('agent', 'description')
				AND target_id = ?
				AND id > ?
				AND reverted_at IS NULL
				AND (${actionClauses.join(" OR ")})
		)`,
		binds: [agentId, afterChangeId],
	};
}

async function prepareAgentRestore(
	db: D1Database,
	entry: ChangeLogEntry,
): Promise<PreparedRestore> {
	const snapshot = parseJsonRecord(entry.beforeJson);
	if (snapshot === null) {
		return undoFail("invalid_input", "変更前スナップショットが不正です");
	}
	const afterSnapshot = parseJsonRecord(entry.afterJson);

	const fieldsToRestore = changedAgentFields(entry);
	if (entry.action === "agent_updated" && fieldsToRestore.size === 0) {
		return undoFail("invalid_input", "変更前のエージェント設定が不正です");
	}

	const [newerResult, agentResult] = await db.batch([
		newerAgentRelatedChangesQuery(db, entry.targetId, entry.id),
		db.prepare("SELECT * FROM agents WHERE id = ?").bind(entry.targetId),
	]);
	const newerEntries = ((newerResult?.results ?? []) as ChangeLogRow[]).map(
		changeLogEntryFromRow,
	);
	if (
		newerEntries.some((newer) =>
			setsIntersect(changedAgentFields(newer), fieldsToRestore),
		)
	) {
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
	const newerConflict = newerAgentConflictCondition(
		entry.targetId,
		entry.id,
		fieldsToRestore,
	);

	if (entry.action === "agent_suspended" || entry.action === "agent_resumed") {
		const rawStatus = snapshot.status;
		if (
			typeof rawStatus !== "string" ||
			!(AGENT_STATUSES as readonly string[]).includes(rawStatus)
		) {
			return undoFail("invalid_input", "変更前のエージェント状態が不正です");
		}
		const prevStatus = rawStatus as AgentStatus;
		const rawAfterStatus = afterSnapshot?.status;
		const expectedStatus: AgentStatus =
			typeof rawAfterStatus === "string" &&
			(AGENT_STATUSES as readonly string[]).includes(rawAfterStatus)
				? (rawAfterStatus as AgentStatus)
				: entry.action === "agent_suspended"
					? "suspended"
					: "active";
		if (current.status !== expectedStatus) {
			return undoFail(
				"conflict_newer_change",
				"対象エージェントの状態が変更されているため元に戻せません",
			);
		}
		return {
			ok: true,
			precondition: {
				sql: `${newerConflict.sql}
					AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND status = ?)`,
				binds: [...newerConflict.binds, current.id, expectedStatus],
			},
			buildStatements: (claimSql, claimTag) => ({
				restore: db
					.prepare(
						`UPDATE agents SET status = ? WHERE id = ? AND status = ? AND ${claimSql}`,
					)
					.bind(prevStatus, current.id, expectedStatus, claimTag),
				extras:
					prevStatus === "suspended"
						? [
								db
									.prepare(
										`DELETE FROM webhook_deliveries
										WHERE agent_id = ? AND status = 'pending' AND ${claimSql}`,
									)
									.bind(current.id, claimTag),
							]
						: undefined,
			}),
		};
	}

	const setClauses: string[] = [];
	const setBinds: (string | number)[] = [];
	const whereClauses: string[] = [];
	const whereBinds: (string | number)[] = [];
	let duplicateNameGuard: string | null = null;

	if (fieldsToRestore.has("name")) {
		const rawName = snapshot.name;
		if (typeof rawName !== "string") {
			return undoFail("invalid_input", "変更前のエージェント名が不正です");
		}
		const expectedName =
			typeof afterSnapshot?.name === "string"
				? afterSnapshot.name
				: current.name;
		if (current.name !== expectedName) {
			return undoFail(
				"conflict_newer_change",
				"対象エージェントの状態が変更されているため元に戻せません",
			);
		}
		let nextName = current.name;
		if (rawName !== current.name) {
			const nameCheck = validateName(rawName);
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
			duplicateNameGuard = nextName;
		}
		setClauses.push("name = ?");
		setBinds.push(nextName);
		whereClauses.push("name = ?");
		whereBinds.push(expectedName);
	}

	if (fieldsToRestore.has("description")) {
		const rawDescription = snapshot.description;
		if (typeof rawDescription !== "string") {
			return undoFail("invalid_input", "変更前の説明文が不正です");
		}
		const expectedDescription =
			typeof afterSnapshot?.description === "string"
				? afterSnapshot.description
				: current.description;
		if (current.description !== expectedDescription) {
			return undoFail(
				"conflict_newer_change",
				"対象エージェントの状態が変更されているため元に戻せません",
			);
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
		setClauses.push("description = ?");
		setBinds.push(nextDescription);
		whereClauses.push("description = ?");
		whereBinds.push(expectedDescription);
	}

	if (fieldsToRestore.has("dailyQuestionLimit")) {
		const rawLimit = snapshot.dailyQuestionLimit;
		if (typeof rawLimit !== "number") {
			return undoFail("invalid_input", "変更前のエージェント設定が不正です");
		}
		const expectedLimit =
			typeof afterSnapshot?.dailyQuestionLimit === "number" &&
			Number.isSafeInteger(afterSnapshot.dailyQuestionLimit)
				? afterSnapshot.dailyQuestionLimit
				: current.dailyQuestionLimit;
		if (current.dailyQuestionLimit !== expectedLimit) {
			return undoFail(
				"conflict_newer_change",
				"対象エージェントの状態が変更されているため元に戻せません",
			);
		}
		const limitCheck = validateDailyLimit(rawLimit);
		if (!limitCheck.ok) {
			return undoFail("invalid_input", limitCheck.message);
		}
		setClauses.push("daily_question_limit = ?");
		setBinds.push(limitCheck.value);
		whereClauses.push("daily_question_limit = ?");
		whereBinds.push(expectedLimit);
	}

	if (setClauses.length === 0) {
		return undoFail("invalid_input", "変更前のエージェント設定が不正です");
	}

	const expectedWhereSql = whereClauses.join(" AND ");
	const preconditionClauses = [
		newerConflict.sql,
		`EXISTS (SELECT 1 FROM agents WHERE id = ? AND ${expectedWhereSql})`,
	];
	const preconditionBinds: unknown[] = [
		...newerConflict.binds,
		current.id,
		...whereBinds,
	];
	if (duplicateNameGuard !== null) {
		preconditionClauses.push(
			"NOT EXISTS (SELECT 1 FROM agents WHERE name = ? AND id <> ?)",
		);
		preconditionBinds.push(duplicateNameGuard, current.id);
	}

	return {
		ok: true,
		precondition: {
			sql: preconditionClauses.join("\n\t\t\tAND "),
			binds: preconditionBinds,
		},
		buildStatements: (claimSql, claimTag) => ({
			restore: db
				.prepare(
					`UPDATE agents SET ${setClauses.join(", ")}
					WHERE id = ? AND ${expectedWhereSql} AND ${claimSql}`,
				)
				.bind(...setBinds, current.id, ...whereBinds, claimTag),
		}),
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

	const basePreconditionSql = `NOT EXISTS (
		SELECT 1 FROM change_log
		WHERE target_type = 'allow_rule' AND target_id = ? AND id > ?
			AND reverted_at IS NULL AND action <> 'change_reverted'
	)
	AND NOT EXISTS (
		SELECT 1 FROM change_log
		WHERE id > ? AND reverted_at IS NULL
			AND (
				(target_type = 'agent' AND target_id IN (?, ?) AND action = 'agent_deleted')
				OR (target_type = 'category' AND target_id = ? AND action = 'category_deleted')
			)
	)
	AND EXISTS (SELECT 1 FROM agents WHERE id = ?)
	AND EXISTS (SELECT 1 FROM agents WHERE id = ?)
	AND EXISTS (SELECT 1 FROM categories WHERE id = ?)`;
	const basePreconditionBinds: unknown[] = [
		entry.targetId,
		entry.id,
		entry.id,
		rule.fromAgentId,
		rule.toAgentId,
		rule.categoryId,
		rule.fromAgentId,
		rule.toAgentId,
		rule.categoryId,
	];

	const ruleExists = (existingRule?.results.length ?? 0) > 0;
	if (entry.action === "allow_rule_revoked") {
		if (ruleExists) {
			return undoFail("duplicate_rule", "同じ許可ルールがすでに存在します");
		}
		const createdAt = rule.createdAt ?? now;
		return {
			ok: true,
			precondition: {
				sql: `${basePreconditionSql}
					AND NOT EXISTS (
						SELECT 1 FROM allow_rules
						WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?
					)`,
				binds: [
					...basePreconditionBinds,
					rule.fromAgentId,
					rule.toAgentId,
					rule.categoryId,
				],
			},
			buildStatements: (claimSql, claimTag) => ({
				restore: db
					.prepare(
						`INSERT INTO allow_rules
							(from_agent_id, to_agent_id, category_id, created_at)
						SELECT ?, ?, ?, ?
						WHERE ${claimSql}
							AND NOT EXISTS (
								SELECT 1 FROM allow_rules
								WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?
							)`,
					)
					.bind(
						rule.fromAgentId,
						rule.toAgentId,
						rule.categoryId,
						createdAt,
						claimTag,
						rule.fromAgentId,
						rule.toAgentId,
						rule.categoryId,
					),
			}),
		};
	}

	if (!ruleExists) {
		return undoFail("not_found", "対象の許可ルールが見つかりません");
	}
	return {
		ok: true,
		precondition: {
			sql: `${basePreconditionSql}
				AND EXISTS (
					SELECT 1 FROM allow_rules
					WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?
				)`,
			binds: [
				...basePreconditionBinds,
				rule.fromAgentId,
				rule.toAgentId,
				rule.categoryId,
			],
		},
		buildStatements: (claimSql, claimTag) => ({
			restore: db
				.prepare(
					`DELETE FROM allow_rules
					WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?
						AND ${claimSql}`,
				)
				.bind(rule.fromAgentId, rule.toAgentId, rule.categoryId, claimTag),
		}),
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
	const expectedName =
		snapshot !== null ? readNonEmptyString(snapshot, "name") : null;

	const [catConflict, existingRule, categoryResult] = await db.batch([
		newerTargetChangeQuery(db, "category", entry.targetId, entry.id),
		db
			.prepare(
				"SELECT 1 AS found FROM allow_rules WHERE category_id = ? LIMIT 1",
			)
			.bind(categoryId),
		db.prepare("SELECT id, name FROM categories WHERE id = ?").bind(categoryId),
	]);

	if (
		(catConflict?.results.length ?? 0) > 0 ||
		(existingRule?.results.length ?? 0) > 0
	) {
		return undoFail(
			"conflict_newer_change",
			"対象カテゴリに新しい変更または使用中の許可ルールがあるため元に戻せません",
		);
	}

	const categoryRow = (categoryResult?.results[0] ?? null) as {
		id: string;
		name: string;
	} | null;
	if (categoryRow === null) {
		return undoFail("not_found", "対象のカテゴリが見つかりません");
	}
	if (expectedName !== null && categoryRow.name !== expectedName) {
		return undoFail(
			"conflict_newer_change",
			"対象カテゴリの状態が変更されているため元に戻せません",
		);
	}

	const categoryWhereSql =
		expectedName !== null ? "id = ? AND name = ?" : "id = ?";
	const categoryWhereBinds =
		expectedName !== null ? [categoryId, expectedName] : [categoryId];

	return {
		ok: true,
		precondition: {
			sql: `NOT EXISTS (
				SELECT 1 FROM change_log
				WHERE target_type = 'category' AND target_id = ? AND id > ?
					AND reverted_at IS NULL AND action <> 'change_reverted'
			)
			AND NOT EXISTS (
				SELECT 1 FROM allow_rules WHERE category_id = ?
			)
			AND EXISTS (
				SELECT 1 FROM categories WHERE ${categoryWhereSql}
			)`,
			binds: [entry.targetId, entry.id, categoryId, ...categoryWhereBinds],
		},
		buildStatements: (claimSql, claimTag) => ({
			restore: db
				.prepare(
					`DELETE FROM categories WHERE ${categoryWhereSql} AND ${claimSql}`,
				)
				.bind(...categoryWhereBinds, claimTag),
		}),
	};
}

async function prepareRestoreForAction(
	db: D1Database,
	entry: ChangeLogEntry & { action: UndoableChangeAction },
	now: UnixMillis,
): Promise<PreparedRestore> {
	switch (entry.action) {
		case "agent_suspended":
		case "agent_resumed":
		case "agent_updated":
		case "description_approved":
			return prepareAgentRestore(db, entry);
		case "allow_rule_revoked":
		case "allow_rule_granted":
			return prepareAllowRuleRestore(db, entry, now);
		case "category_created":
			return prepareCategoryRestore(db, entry);
	}
}

async function diagnoseUndoFailure(
	db: D1Database,
	entry: ChangeLogEntry & { action: UndoableChangeAction },
	now: UnixMillis,
): Promise<UndoFailure> {
	const latest = await db
		.prepare("SELECT reverted_at FROM change_log WHERE id = ?")
		.bind(entry.id)
		.first<{ reverted_at: number | null }>();
	if (latest === null) {
		return undoFail("not_found", "指定された変更履歴が見つかりません");
	}
	if (latest.reverted_at !== null) {
		return undoFail("already_reverted", "この変更はすでに元に戻されています");
	}
	const rechecked = await prepareRestoreForAction(db, entry, now);
	if (!rechecked.ok) {
		return rechecked;
	}
	return undoFail(
		"conflict_newer_change",
		"競合する変更が発生したため元に戻せませんでした",
	);
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

	const undoableEntry: ChangeLogEntry & { action: UndoableChangeAction } = {
		...entry,
		action: entry.action,
	};
	const prepared = await prepareRestoreForAction(
		db,
		undoableEntry,
		ctx.value.now,
	);
	if (!prepared.ok) {
		return prepared;
	}

	const claimTag = -entry.id;
	const { restore, extras = [] } = prepared.buildStatements(
		REVERT_CLAIM_SQL,
		claimTag,
	);

	// The new `change_reverted` row holds `-entry.id` in `reverted_at` only
	// inside this transaction so every later statement in the batch can verify
	// that this transaction (and not a concurrent one) claimed the revert.
	const insertRevertLogStmt = db
		.prepare(
			`INSERT INTO change_log
				(occurred_at, actor_type, actor_id, approver_id, action,
				target_type, target_id, before_json, after_json, reverted_at)
			SELECT ?, 'owner', ?, ?, 'change_reverted', ?, ?, ?, ?, ?
			WHERE EXISTS (SELECT 1 FROM change_log WHERE id = ? AND reverted_at IS NULL)
				AND ${prepared.precondition.sql}`,
		)
		.bind(
			ctx.value.now,
			ctx.value.actorId,
			ctx.value.approverId,
			entry.targetType,
			entry.targetId,
			entry.afterJson,
			entry.beforeJson,
			claimTag,
			entry.id,
			...prepared.precondition.binds,
		);
	const markRevertedStmt = db
		.prepare(
			`UPDATE change_log
			SET reverted_at = ?
			WHERE id = ? AND reverted_at IS NULL AND ${REVERT_CLAIM_SQL}`,
		)
		.bind(ctx.value.now, entry.id, claimTag);
	const clearClaimStmt = db
		.prepare(
			`UPDATE change_log
			SET reverted_at = NULL
			WHERE action = 'change_reverted' AND reverted_at = ?`,
		)
		.bind(claimTag);

	try {
		const results = await db.batch([
			insertRevertLogStmt,
			restore,
			...extras,
			markRevertedStmt,
			clearClaimStmt,
		]);
		const insertResult = results[0];
		const markRevertedResult = results.at(-2);
		if (
			(insertResult?.meta.changes ?? 0) === 0 ||
			(markRevertedResult?.meta.changes ?? 0) === 0
		) {
			return diagnoseUndoFailure(db, undoableEntry, ctx.value.now);
		}
		const changeId = Number(insertResult?.meta.last_row_id);
		if (!Number.isSafeInteger(changeId) || changeId <= 0) {
			throw new Error("change_log insert did not return a valid last_row_id");
		}

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
