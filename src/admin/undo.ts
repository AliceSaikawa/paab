import {
	type AgentRow,
	agentFromRow,
	type ChangeLogRow,
	changeLogEntryFromRow,
	insertAllowRule,
	insertChangeLogEntry,
	insertPendingDescription,
	newId,
} from "../db";
import {
	AGENT_STATUSES,
	type Agent,
	type AgentStatus,
	type ChangeAction,
	type ChangeLogEntry,
	type ChangeTargetType,
	type PendingDescription,
	type UnixMillis,
} from "../types";
import { type ListAdminBotChangesOptions, listAdminBotChanges } from "./query";
import type { AdminErrorCode, ChangeActor } from "./types";
import {
	isUniqueConstraintError,
	validateContext,
	validateDailyLimit,
	validateDescription,
	validateName,
} from "./validate";

export { type ListAdminBotChangesOptions, listAdminBotChanges };

export const UNDOABLE_CHANGE_ACTIONS = [
	"agent_suspended",
	"agent_resumed",
	"agent_updated",
	"allow_rule_revoked",
	"allow_rule_granted",
	"category_created",
	"description_approved",
	"description_rejected",
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
	cascade?: boolean;
}

export interface RevertedChangeSummary {
	revertedChangeId: number;
	action: UndoableChangeAction;
	targetType: ChangeTargetType;
	targetId: string;
	revertedChangeIds?: number[];
}

export type ChangeUndoAvailability =
	| { kind: "ready" }
	| { kind: "cascade"; count: number; blockerIds: number[] }
	| { kind: "blocked"; reason: string };

interface AllowRuleSnapshot {
	fromAgentId: string;
	toAgentId: string;
	categoryId: string;
	createdAt: number | null;
}

interface AllowRuleKey {
	fromAgentId: string;
	toAgentId: string;
	categoryId: string;
}

type BlockerAnalysis =
	| { kind: "ready" }
	| { kind: "cascade"; blockers: ChangeLogEntry[] }
	| { kind: "blocked"; reason: string };

type PreparedRestore =
	| {
			ok: true;
			mutations: D1PreparedStatement[];
			revertedEntries: ChangeLogEntry[];
	  }
	| UndoFailure;

function undoFail(code: UndoErrorCode, message: string): UndoFailure {
	return { ok: false, code, message };
}

/** Returns whether `action` can be reverted by `revertAdminBotChange`. */
export function isUndoableChangeAction(
	action: ChangeAction,
): action is UndoableChangeAction {
	return (UNDOABLE_CHANGE_ACTIONS as readonly string[]).includes(action);
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

function parseAllowRuleSnapshot(raw: string | null): AllowRuleSnapshot | null {
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

function parseAllowRuleEntrySnapshot(
	entry: ChangeLogEntry,
): AllowRuleSnapshot | null {
	const rawSnapshot =
		entry.action === "allow_rule_revoked" ? entry.beforeJson : entry.afterJson;
	const rule = parseAllowRuleSnapshot(rawSnapshot);
	if (
		rule === null ||
		rule.fromAgentId === rule.toAgentId ||
		`${rule.fromAgentId}:${rule.toAgentId}:${rule.categoryId}` !==
			entry.targetId
	) {
		return null;
	}
	return rule;
}

function parseRejectedDescriptionSnapshot(
	entry: ChangeLogEntry,
): { ok: true; pending: PendingDescription } | UndoFailure {
	const snapshot = parseJsonRecord(entry.beforeJson);
	if (snapshot === null) {
		return undoFail("invalid_input", "変更前スナップショットが不正です");
	}
	const rawAgentId =
		readNonEmptyString(snapshot, "agentId") ??
		readNonEmptyString(snapshot, "agent_id");
	if (rawAgentId !== null && rawAgentId !== entry.targetId) {
		return undoFail(
			"invalid_input",
			"変更前の説明文スナップショットが不正です",
		);
	}
	const rawDescription = snapshot.description;
	if (typeof rawDescription !== "string") {
		return undoFail("invalid_input", "変更前の説明文が不正です");
	}
	const descriptionCheck = validateDescription(rawDescription);
	if (!descriptionCheck.ok) {
		return undoFail("invalid_input", descriptionCheck.message);
	}
	const submissionId =
		readNonEmptyString(snapshot, "submissionId") ??
		readNonEmptyString(snapshot, "submission_id") ??
		newId();
	const rawSubmittedAt = snapshot.submittedAt ?? snapshot.submitted_at;
	const submittedAt =
		typeof rawSubmittedAt === "number" && Number.isSafeInteger(rawSubmittedAt)
			? rawSubmittedAt
			: entry.occurredAt;

	return {
		ok: true,
		pending: {
			agentId: entry.targetId,
			submissionId,
			description: descriptionCheck.value,
			submittedAt,
		},
	};
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

function canCascadeBlocker(entry: ChangeLogEntry): boolean {
	return (
		entry.actorType === "admin_bot" && isUndoableChangeAction(entry.action)
	);
}

function classifyBlockers(blockers: ChangeLogEntry[]): BlockerAnalysis {
	if (blockers.length === 0) {
		return { kind: "ready" };
	}
	if (blockers.every(canCascadeBlocker)) {
		return { kind: "cascade", blockers };
	}
	const hasOwnerBlocker = blockers.some((b) => b.actorType === "owner");
	return {
		kind: "blocked",
		reason: hasOwnerBlocker
			? "所有者の変更があるためまとめて元に戻せません"
			: "自動取消できない新しい変更があるためまとめて元に戻せません",
	};
}

function analyzeAgentChangeBlockers(
	entry: ChangeLogEntry,
	newerAgentOrDescEntries: readonly ChangeLogEntry[],
): BlockerAnalysis {
	const affectedFields = new Set<AgentField>(changedAgentFields(entry));
	const blockers: ChangeLogEntry[] = [];
	for (const newer of newerAgentOrDescEntries) {
		const newerFields = changedAgentFields(newer);
		if (setsIntersect(newerFields, affectedFields)) {
			blockers.push(newer);
			for (const field of newerFields) {
				affectedFields.add(field);
			}
		}
	}
	return classifyBlockers(blockers);
}

function analyzeDescriptionRejectedBlockers(
	newerAgentOrDescEntries: readonly ChangeLogEntry[],
	hasPendingDescription: boolean,
): BlockerAnalysis {
	if (hasPendingDescription) {
		return {
			kind: "blocked",
			reason: "新しい承認待ちの説明文がすでにあるため元に戻せません",
		};
	}
	const affectedFields = new Set<AgentField>();
	const blockers: ChangeLogEntry[] = [];
	let hasNewerRejection = false;
	for (const newer of newerAgentOrDescEntries) {
		if (newer.action === "description_rejected") {
			blockers.push(newer);
			hasNewerRejection = true;
			continue;
		}
		if (newer.action === "description_approved") {
			blockers.push(newer);
			affectedFields.add("description");
			continue;
		}
		if (affectedFields.size > 0) {
			const newerFields = changedAgentFields(newer);
			if (setsIntersect(newerFields, affectedFields)) {
				blockers.push(newer);
				for (const field of newerFields) {
					affectedFields.add(field);
				}
			}
		}
	}
	if (blockers.length === 0) {
		return { kind: "ready" };
	}
	if (hasNewerRejection) {
		return {
			kind: "blocked",
			reason:
				"より新しい説明文却下があるためまとめて元に戻せません（新しい変更から順に処理してください）",
		};
	}
	return classifyBlockers(blockers);
}

function simulateAllowRuleRollback(
	chainDesc: readonly ChangeLogEntry[],
	currentExists: boolean,
): { ok: true; finalExists: boolean } | UndoFailure {
	let simulatedExists = currentExists;
	for (const item of chainDesc) {
		if (parseAllowRuleEntrySnapshot(item) === null) {
			return undoFail(
				"invalid_input",
				"許可ルールのスナップショットが不正です",
			);
		}
		if (item.action === "allow_rule_revoked") {
			if (simulatedExists) {
				return undoFail("duplicate_rule", "同じ許可ルールがすでに存在します");
			}
			simulatedExists = true;
		} else if (item.action === "allow_rule_granted") {
			if (!simulatedExists) {
				return undoFail("not_found", "対象の許可ルールが見つかりません");
			}
			simulatedExists = false;
		} else {
			return undoFail("not_undoable", "この種類の変更は元に戻せません");
		}
	}
	return { ok: true, finalExists: simulatedExists };
}

function analyzeAllowRuleBlockers(
	newerRuleEntries: readonly ChangeLogEntry[],
	hasDependencyDeletion: boolean,
): BlockerAnalysis {
	if (hasDependencyDeletion) {
		return {
			kind: "blocked",
			reason:
				"許可ルールが参照するエージェントまたはカテゴリに削除履歴があるため元に戻せません",
		};
	}
	return classifyBlockers([...newerRuleEntries]);
}

function analyzeCategoryBlockers(
	newerCategoryEntries: readonly ChangeLogEntry[],
	existingRulesForCategory: readonly AllowRuleKey[],
	newerAllowRuleEntriesForCategory: readonly ChangeLogEntry[],
): BlockerAnalysis {
	if (newerCategoryEntries.length > 0) {
		return {
			kind: "blocked",
			reason: "対象カテゴリに新しい変更があるため元に戻せません",
		};
	}
	if (existingRulesForCategory.length === 0) {
		return { kind: "ready" };
	}

	const entriesByRule = new Map<string, ChangeLogEntry[]>();
	for (const item of newerAllowRuleEntriesForCategory) {
		let list = entriesByRule.get(item.targetId);
		if (list === undefined) {
			list = [];
			entriesByRule.set(item.targetId, list);
		}
		list.push(item);
	}

	const blockers: ChangeLogEntry[] = [];
	for (const rule of existingRulesForCategory) {
		const targetId = `${rule.fromAgentId}:${rule.toAgentId}:${rule.categoryId}`;
		const ruleEntries = entriesByRule.get(targetId) ?? [];
		if (ruleEntries.length === 0 || !ruleEntries.every(canCascadeBlocker)) {
			return {
				kind: "blocked",
				reason:
					"所有者による許可ルールなど自動取消できないルールがこのカテゴリを使用中のため元に戻せません",
			};
		}
		const sim = simulateAllowRuleRollback([...ruleEntries].reverse(), true);
		if (!sim.ok || sim.finalExists) {
			return {
				kind: "blocked",
				reason:
					"対象カテゴリを使用中の許可ルールを安全に巻き戻せないため元に戻せません",
			};
		}
		blockers.push(...ruleEntries);
	}

	blockers.sort((a, b) => a.id - b.id);
	return { kind: "cascade", blockers };
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

function newerTargetChangesQuery(
	db: D1Database,
	targetType: ChangeTargetType,
	targetId: string,
	afterChangeId: number,
): D1PreparedStatement {
	return db
		.prepare(
			`SELECT * FROM change_log
			WHERE target_type = ? AND target_id = ? AND id > ?
				AND reverted_at IS NULL AND action <> 'change_reverted'
			ORDER BY id ASC`,
		)
		.bind(targetType, targetId, afterChangeId);
}

async function buildAgentMutationsFromChain(
	db: D1Database,
	current: Agent,
	chainAsc: readonly ChangeLogEntry[],
): Promise<{ ok: true; mutations: D1PreparedStatement[] } | UndoFailure> {
	const earliestSnapshotByField = new Map<
		AgentField,
		{ entry: ChangeLogEntry; snapshot: Record<string, unknown> }
	>();

	for (const item of chainAsc) {
		const snapshot = parseJsonRecord(item.beforeJson);
		if (snapshot === null) {
			return undoFail("invalid_input", "変更前スナップショットが不正です");
		}
		const fields = changedAgentFields(item);
		if (item.action === "agent_updated" && fields.size === 0) {
			return undoFail("invalid_input", "変更前のエージェント設定が不正です");
		}
		for (const field of fields) {
			if (!earliestSnapshotByField.has(field)) {
				earliestSnapshotByField.set(field, { entry: item, snapshot });
			}
		}
	}

	const setClauses: string[] = [];
	const binds: (string | number)[] = [];
	const extraStatements: D1PreparedStatement[] = [];

	const statusSource = earliestSnapshotByField.get("status");
	if (statusSource !== undefined) {
		const rawStatus = statusSource.snapshot.status;
		if (
			typeof rawStatus !== "string" ||
			!(AGENT_STATUSES as readonly string[]).includes(rawStatus)
		) {
			return undoFail("invalid_input", "変更前のエージェント状態が不正です");
		}
		const prevStatus = rawStatus as AgentStatus;
		setClauses.push("status = ?");
		binds.push(prevStatus);
		if (prevStatus === "suspended") {
			extraStatements.push(
				db
					.prepare(
						"DELETE FROM webhook_deliveries WHERE agent_id = ? AND status = 'pending'",
					)
					.bind(current.id),
			);
		}
	}

	const nameSource = earliestSnapshotByField.get("name");
	if (nameSource !== undefined) {
		const rawName = nameSource.snapshot.name;
		if (typeof rawName !== "string") {
			return undoFail("invalid_input", "変更前のエージェント名が不正です");
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
		}
		setClauses.push("name = ?");
		binds.push(nextName);
	}

	const descriptionSource = earliestSnapshotByField.get("description");
	if (descriptionSource !== undefined) {
		const rawDescription = descriptionSource.snapshot.description;
		if (typeof rawDescription !== "string") {
			return undoFail("invalid_input", "変更前の説明文が不正です");
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
		binds.push(nextDescription);
	}

	const limitSource = earliestSnapshotByField.get("dailyQuestionLimit");
	if (limitSource !== undefined) {
		const rawLimit = limitSource.snapshot.dailyQuestionLimit;
		if (typeof rawLimit !== "number") {
			return undoFail("invalid_input", "変更前のエージェント設定が不正です");
		}
		const limitCheck = validateDailyLimit(rawLimit);
		if (!limitCheck.ok) {
			return undoFail("invalid_input", limitCheck.message);
		}
		setClauses.push("daily_question_limit = ?");
		binds.push(limitCheck.value);
	}

	if (setClauses.length === 0) {
		return undoFail("invalid_input", "変更前のエージェント設定が不正です");
	}

	return {
		ok: true,
		mutations: [
			db
				.prepare(`UPDATE agents SET ${setClauses.join(", ")} WHERE id = ?`)
				.bind(...binds, current.id),
			...extraStatements,
		],
	};
}

async function prepareAgentRestore(
	db: D1Database,
	entry: ChangeLogEntry,
	cascade: boolean,
): Promise<PreparedRestore> {
	const snapshot = parseJsonRecord(entry.beforeJson);
	if (snapshot === null) {
		return undoFail("invalid_input", "変更前スナップショットが不正です");
	}

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
	const analysis = analyzeAgentChangeBlockers(entry, newerEntries);

	if (analysis.kind !== "ready") {
		if (!cascade) {
			return undoFail(
				"conflict_newer_change",
				"対象エージェントに新しい変更があるため元に戻せません",
			);
		}
		if (analysis.kind === "blocked") {
			return undoFail("conflict_newer_change", analysis.reason);
		}
	}

	const agentRow = (agentResult?.results[0] ?? null) as AgentRow | null;
	if (agentRow === null) {
		return undoFail("not_found", "対象のエージェントが見つかりません");
	}
	const current = agentFromRow(agentRow);

	const chainAsc =
		analysis.kind === "cascade" ? [entry, ...analysis.blockers] : [entry];
	const built = await buildAgentMutationsFromChain(db, current, chainAsc);
	if (!built.ok) {
		return built;
	}

	return {
		ok: true,
		mutations: built.mutations,
		revertedEntries: [...chainAsc].reverse(),
	};
}

async function prepareDescriptionRejectedRestore(
	db: D1Database,
	entry: ChangeLogEntry,
	cascade: boolean,
): Promise<PreparedRestore> {
	const parsed = parseRejectedDescriptionSnapshot(entry);
	if (!parsed.ok) {
		return parsed;
	}

	const [agentResult, pendingResult, newerResult] = await db.batch([
		db.prepare("SELECT * FROM agents WHERE id = ?").bind(entry.targetId),
		db
			.prepare("SELECT agent_id FROM pending_descriptions WHERE agent_id = ?")
			.bind(entry.targetId),
		newerAgentRelatedChangesQuery(db, entry.targetId, entry.id),
	]);

	const agentRow = (agentResult?.results[0] ?? null) as AgentRow | null;
	if (agentRow === null) {
		return undoFail("not_found", "対象のエージェントが見つかりません");
	}

	const hasPendingDescription = (pendingResult?.results.length ?? 0) > 0;
	const newerEntries = ((newerResult?.results ?? []) as ChangeLogRow[]).map(
		changeLogEntryFromRow,
	);
	const analysis = analyzeDescriptionRejectedBlockers(
		newerEntries,
		hasPendingDescription,
	);

	if (analysis.kind === "blocked") {
		return undoFail("conflict_newer_change", analysis.reason);
	}
	if (analysis.kind === "cascade" && !cascade) {
		return undoFail(
			"conflict_newer_change",
			"対象エージェントの説明文に新しい変更があるため元に戻せません",
		);
	}

	const mutations: D1PreparedStatement[] = [];
	if (analysis.kind === "cascade") {
		const current = agentFromRow(agentRow);
		const built = await buildAgentMutationsFromChain(
			db,
			current,
			analysis.blockers,
		);
		if (!built.ok) {
			return built;
		}
		mutations.push(...built.mutations);
	}
	mutations.push(insertPendingDescription(db, parsed.pending));

	const revertedEntries =
		analysis.kind === "cascade"
			? [...analysis.blockers].reverse().concat(entry)
			: [entry];

	return {
		ok: true,
		mutations,
		revertedEntries,
	};
}

async function prepareAllowRuleRestore(
	db: D1Database,
	entry: ChangeLogEntry,
	now: UnixMillis,
	cascade: boolean,
): Promise<PreparedRestore> {
	const rule = parseAllowRuleEntrySnapshot(entry);
	if (rule === null) {
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
		newerTargetChangesQuery(db, "allow_rule", entry.targetId, entry.id),
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

	const newerRuleEntries = (
		(ruleConflict?.results ?? []) as ChangeLogRow[]
	).map(changeLogEntryFromRow);
	const hasDependencyDeletion = (dependencyConflict?.results.length ?? 0) > 0;
	const analysis = analyzeAllowRuleBlockers(
		newerRuleEntries,
		hasDependencyDeletion,
	);

	if (analysis.kind !== "ready") {
		if (!cascade) {
			return undoFail(
				"conflict_newer_change",
				"許可ルールまたは対象エージェント・カテゴリに新しい変更があるため元に戻せません",
			);
		}
		if (analysis.kind === "blocked") {
			return undoFail("conflict_newer_change", analysis.reason);
		}
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
	const revertedEntries =
		analysis.kind === "cascade"
			? [...analysis.blockers].reverse().concat(entry)
			: [entry];

	const sim = simulateAllowRuleRollback(revertedEntries, ruleExists);
	if (!sim.ok) {
		return sim;
	}

	const mutations: D1PreparedStatement[] = [];
	if (sim.finalExists && !ruleExists) {
		mutations.push(
			insertAllowRule(db, {
				fromAgentId: rule.fromAgentId,
				toAgentId: rule.toAgentId,
				categoryId: rule.categoryId,
				createdAt: rule.createdAt ?? now,
			}),
		);
	} else if (!sim.finalExists && ruleExists) {
		mutations.push(
			db
				.prepare(
					`DELETE FROM allow_rules
					WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
				)
				.bind(rule.fromAgentId, rule.toAgentId, rule.categoryId),
		);
	}

	return {
		ok: true,
		mutations,
		revertedEntries,
	};
}

async function prepareCategoryRestore(
	db: D1Database,
	entry: ChangeLogEntry,
	cascade: boolean,
): Promise<PreparedRestore> {
	const snapshot = parseJsonRecord(entry.afterJson);
	const categoryId =
		snapshot !== null ? readNonEmptyString(snapshot, "id") : null;
	if (categoryId === null || categoryId !== entry.targetId) {
		return undoFail("invalid_input", "カテゴリのスナップショットが不正です");
	}

	const [catConflict, existingRulesResult, categoryRow, newerRuleChanges] =
		await db.batch([
			newerTargetChangesQuery(db, "category", entry.targetId, entry.id),
			db
				.prepare(
					`SELECT from_agent_id, to_agent_id, category_id
					FROM allow_rules
					WHERE category_id = ?`,
				)
				.bind(categoryId),
			db.prepare("SELECT id FROM categories WHERE id = ?").bind(categoryId),
			db
				.prepare(
					`SELECT * FROM change_log
					WHERE target_type = 'allow_rule' AND id > ?
						AND reverted_at IS NULL AND action <> 'change_reverted'
						AND target_id LIKE ?
					ORDER BY id ASC`,
				)
				.bind(entry.id, `%:${categoryId}`),
		]);

	const newerCategoryEntries = (
		(catConflict?.results ?? []) as ChangeLogRow[]
	).map(changeLogEntryFromRow);
	const existingRules = (
		(existingRulesResult?.results ?? []) as {
			from_agent_id: string;
			to_agent_id: string;
			category_id: string;
		}[]
	).map((row) => ({
		fromAgentId: row.from_agent_id,
		toAgentId: row.to_agent_id,
		categoryId: row.category_id,
	}));
	const newerAllowRuleEntries = (
		(newerRuleChanges?.results ?? []) as ChangeLogRow[]
	)
		.map(changeLogEntryFromRow)
		.filter((item) => item.targetId.endsWith(`:${categoryId}`));

	const analysis = analyzeCategoryBlockers(
		newerCategoryEntries,
		existingRules,
		newerAllowRuleEntries,
	);

	if (analysis.kind !== "ready") {
		if (!cascade) {
			return undoFail(
				"conflict_newer_change",
				"対象カテゴリに新しい変更または使用中の許可ルールがあるため元に戻せません",
			);
		}
		if (analysis.kind === "blocked") {
			return undoFail("conflict_newer_change", analysis.reason);
		}
	}

	if ((categoryRow?.results.length ?? 0) === 0) {
		return undoFail("not_found", "対象のカテゴリが見つかりません");
	}

	const mutations: D1PreparedStatement[] = [];
	if (analysis.kind === "cascade") {
		for (const rule of existingRules) {
			mutations.push(
				db
					.prepare(
						`DELETE FROM allow_rules
						WHERE from_agent_id = ? AND to_agent_id = ? AND category_id = ?`,
					)
					.bind(rule.fromAgentId, rule.toAgentId, rule.categoryId),
			);
		}
	}
	mutations.push(
		db.prepare("DELETE FROM categories WHERE id = ?").bind(categoryId),
	);

	const revertedEntries =
		analysis.kind === "cascade"
			? [...analysis.blockers].reverse().concat(entry)
			: [entry];

	return {
		ok: true,
		mutations,
		revertedEntries,
	};
}

/**
 * Inspects whether each un-reverted undoable `admin_bot` entry can be undone
 * directly, requires cascade rollback over newer `admin_bot` changes, or is
 * blocked by an owner/non-undoable conflict. Runs in one `db.batch`.
 */
export async function inspectAdminBotChangesUndoState(
	db: D1Database,
	entries: readonly ChangeLogEntry[],
): Promise<Map<number, ChangeUndoAvailability>> {
	const result = new Map<number, ChangeUndoAvailability>();
	const candidates = entries.filter(
		(entry) =>
			entry.actorType === "admin_bot" &&
			entry.revertedAt === null &&
			isUndoableChangeAction(entry.action),
	);
	if (candidates.length === 0) {
		return result;
	}

	const minId = candidates.reduce(
		(acc, item) => Math.min(item.id, acc),
		candidates[0]?.id ?? 0,
	);
	const [newerRes, agentsRes, categoriesRes, pendingRes, rulesRes] =
		await db.batch([
			db
				.prepare(
					`SELECT * FROM change_log
					WHERE id > ? AND reverted_at IS NULL AND action <> 'change_reverted'
					ORDER BY id ASC`,
				)
				.bind(minId),
			db.prepare("SELECT id FROM agents"),
			db.prepare("SELECT id FROM categories"),
			db.prepare("SELECT agent_id FROM pending_descriptions"),
			db.prepare(
				"SELECT from_agent_id, to_agent_id, category_id FROM allow_rules",
			),
		]);

	const newerAll = ((newerRes?.results ?? []) as ChangeLogRow[]).map(
		changeLogEntryFromRow,
	);
	const existingAgents = new Set(
		((agentsRes?.results ?? []) as { id: string }[]).map((row) => row.id),
	);
	const existingCategories = new Set(
		((categoriesRes?.results ?? []) as { id: string }[]).map((row) => row.id),
	);
	const pendingAgents = new Set(
		((pendingRes?.results ?? []) as { agent_id: string }[]).map(
			(row) => row.agent_id,
		),
	);
	const existingRules = (
		(rulesRes?.results ?? []) as {
			from_agent_id: string;
			to_agent_id: string;
			category_id: string;
		}[]
	).map((row) => ({
		fromAgentId: row.from_agent_id,
		toAgentId: row.to_agent_id,
		categoryId: row.category_id,
	}));

	const toAvailability = (
		analysis: BlockerAnalysis,
	): ChangeUndoAvailability => {
		if (analysis.kind === "ready") return { kind: "ready" };
		if (analysis.kind === "blocked") {
			return { kind: "blocked", reason: analysis.reason };
		}
		return {
			kind: "cascade",
			count: analysis.blockers.length + 1,
			blockerIds: analysis.blockers.map((b) => b.id),
		};
	};

	for (const entry of candidates) {
		const newer = newerAll.filter((item) => item.id > entry.id);
		switch (entry.action) {
			case "agent_suspended":
			case "agent_resumed":
			case "agent_updated":
			case "description_approved": {
				const agentNewer = newer.filter(
					(item) =>
						(item.targetType === "agent" ||
							item.targetType === "description") &&
						item.targetId === entry.targetId,
				);
				const analysis = analyzeAgentChangeBlockers(entry, agentNewer);
				if (
					analysis.kind !== "blocked" &&
					!existingAgents.has(entry.targetId)
				) {
					result.set(entry.id, {
						kind: "blocked",
						reason: "対象のエージェントが見つかりません",
					});
				} else {
					result.set(entry.id, toAvailability(analysis));
				}
				break;
			}
			case "description_rejected": {
				if (!existingAgents.has(entry.targetId)) {
					result.set(entry.id, {
						kind: "blocked",
						reason: "対象のエージェントが見つかりません",
					});
					break;
				}
				const descNewer = newer.filter(
					(item) =>
						(item.targetType === "agent" ||
							item.targetType === "description") &&
						item.targetId === entry.targetId,
				);
				result.set(
					entry.id,
					toAvailability(
						analyzeDescriptionRejectedBlockers(
							descNewer,
							pendingAgents.has(entry.targetId),
						),
					),
				);
				break;
			}
			case "allow_rule_revoked":
			case "allow_rule_granted": {
				const rule = parseAllowRuleEntrySnapshot(entry);
				if (rule === null) {
					result.set(entry.id, {
						kind: "blocked",
						reason: "許可ルールのスナップショットが不正です",
					});
					break;
				}
				const ruleNewer = newer.filter(
					(item) =>
						item.targetType === "allow_rule" &&
						item.targetId === entry.targetId,
				);
				const hasDependencyDeletion = newer.some(
					(item) =>
						(item.targetType === "agent" &&
							item.action === "agent_deleted" &&
							(item.targetId === rule.fromAgentId ||
								item.targetId === rule.toAgentId)) ||
						(item.targetType === "category" &&
							item.action === "category_deleted" &&
							item.targetId === rule.categoryId),
				);
				const analysis = analyzeAllowRuleBlockers(
					ruleNewer,
					hasDependencyDeletion,
				);
				if (
					analysis.kind !== "blocked" &&
					(!existingAgents.has(rule.fromAgentId) ||
						!existingAgents.has(rule.toAgentId) ||
						!existingCategories.has(rule.categoryId))
				) {
					result.set(entry.id, {
						kind: "blocked",
						reason:
							"許可ルールが参照するエージェントまたはカテゴリが見つかりません",
					});
				} else {
					result.set(entry.id, toAvailability(analysis));
				}
				break;
			}
			case "category_created": {
				if (!existingCategories.has(entry.targetId)) {
					result.set(entry.id, {
						kind: "blocked",
						reason: "対象のカテゴリが見つかりません",
					});
					break;
				}
				const catNewer = newer.filter(
					(item) =>
						item.targetType === "category" && item.targetId === entry.targetId,
				);
				const rulesForCat = existingRules.filter(
					(rule) => rule.categoryId === entry.targetId,
				);
				const ruleNewerForCat = newer.filter(
					(item) =>
						item.targetType === "allow_rule" &&
						item.targetId.endsWith(`:${entry.targetId}`),
				);
				result.set(
					entry.id,
					toAvailability(
						analyzeCategoryBlockers(catNewer, rulesForCat, ruleNewerForCat),
					),
				);
				break;
			}
		}
	}

	return result;
}

/**
 * Reverts one non-reverted `admin_bot` change atomically and records a
 * `"change_reverted"` entry in `change_log`. When `cascade` is `true`, also
 * reverts newer conflicting `admin_bot` changes on the same target in reverse
 * order in one atomic batch, refusing if an `owner` or non-undoable change
 * intervened.
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
	const cascade = input.cascade === true;

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
		case "description_approved":
			prepared = await prepareAgentRestore(db, entry, cascade);
			break;
		case "description_rejected":
			prepared = await prepareDescriptionRejectedRestore(db, entry, cascade);
			break;
		case "allow_rule_revoked":
		case "allow_rule_granted":
			prepared = await prepareAllowRuleRestore(
				db,
				entry,
				ctx.value.now,
				cascade,
			);
			break;
		case "category_created":
			prepared = await prepareCategoryRestore(db, entry, cascade);
			break;
	}
	if (!prepared.ok) {
		return prepared;
	}

	const statements: D1PreparedStatement[] = [...prepared.mutations];
	for (const reverted of prepared.revertedEntries) {
		statements.push(
			db
				.prepare(
					"UPDATE change_log SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL",
				)
				.bind(ctx.value.now, reverted.id),
			insertChangeLogEntry(db, {
				occurredAt: ctx.value.now,
				actorType: "owner",
				actorId: ctx.value.actorId,
				approverId: ctx.value.approverId,
				action: "change_reverted",
				targetType: reverted.targetType,
				targetId: reverted.targetId,
				beforeJson: reverted.afterJson,
				afterJson: reverted.beforeJson,
				revertedAt: null,
			}),
		);
	}

	try {
		const results = await db.batch(statements);
		const changeResult = results.at(-1);
		const changeId = Number(changeResult?.meta.last_row_id);
		if (!Number.isSafeInteger(changeId) || changeId <= 0) {
			throw new Error("change_log insert did not return a valid last_row_id");
		}

		const summary: RevertedChangeSummary = {
			revertedChangeId: entry.id,
			action: entry.action,
			targetType: entry.targetType,
			targetId: entry.targetId,
			...(cascade
				? {
						revertedChangeIds: prepared.revertedEntries.map((item) => item.id),
					}
				: {}),
		};

		return {
			ok: true,
			data: summary,
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
