import {
	type AgentRow,
	agentFromRow,
	type ChangeLogRow,
	changeLogEntryFromRow,
	oneOf,
} from "../db";
import { utcDayStart } from "../policy";
import {
	AGENT_STATUSES,
	type AgentStatus,
	CHANGE_ACTOR_TYPES,
	CHANGE_TARGET_TYPES,
	type ChangeLogEntry,
	TOKEN_PURPOSES,
	type TokenPurpose,
	type UnixMillis,
} from "../types";
import type {
	ActiveTokenSummary,
	AgentWithStatus,
	AllowRuleGroup,
	CategoryWithUsage,
	ChangeLogFilter,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CHANGE_LOG_LIMIT = 100;
export const MAX_CHANGE_LOG_LIMIT = 1000;

export interface ChangeLogQuery {
	sql: string;
	params: (string | number)[];
}

function requireTime(value: number, name: string): number {
	if (!Number.isSafeInteger(value)) {
		throw new RangeError(`${name} must be an integer of UNIX milliseconds`);
	}
	return value;
}

function requireId(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative integer`);
	}
	return value;
}

function requireText(value: string, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new RangeError(`${name} must be a non-empty string`);
	}
	return value;
}

export function buildChangeLogQuery(
	filter: ChangeLogFilter = {},
): ChangeLogQuery {
	const where: string[] = [];
	const params: (string | number)[] = [];
	const add = (condition: string, value: string | number) => {
		where.push(condition);
		params.push(value);
	};

	if (filter.occurredFrom !== undefined) {
		add("occurred_at >= ?", requireTime(filter.occurredFrom, "occurredFrom"));
	}
	if (filter.occurredBefore !== undefined) {
		add(
			"occurred_at < ?",
			requireTime(filter.occurredBefore, "occurredBefore"),
		);
	}
	if (filter.actorType !== undefined) {
		if (!(CHANGE_ACTOR_TYPES as readonly string[]).includes(filter.actorType)) {
			throw new RangeError(
				`actorType must be one of: ${CHANGE_ACTOR_TYPES.join(", ")}`,
			);
		}
		add("actor_type = ?", filter.actorType);
	}
	if (filter.targetType !== undefined) {
		if (
			!(CHANGE_TARGET_TYPES as readonly string[]).includes(filter.targetType)
		) {
			throw new RangeError(
				`targetType must be one of: ${CHANGE_TARGET_TYPES.join(", ")}`,
			);
		}
		add("target_type = ?", filter.targetType);
	}
	if (filter.targetId !== undefined) {
		add("target_id = ?", requireText(filter.targetId, "targetId"));
	}
	if (filter.beforeId !== undefined) {
		add("id < ?", requireId(filter.beforeId, "beforeId"));
	}

	const limit = filter.limit ?? DEFAULT_CHANGE_LOG_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError("limit must be a positive integer");
	}
	params.push(Math.min(limit, MAX_CHANGE_LOG_LIMIT));

	const sql = [
		"SELECT id, occurred_at, actor_type, actor_id, approver_id, action,",
		"target_type, target_id, before_json, after_json, reverted_at",
		"FROM change_log",
		...(where.length > 0 ? [`WHERE ${where.join(" AND ")}`] : []),
		"ORDER BY occurred_at DESC, id DESC",
		"LIMIT ?",
	].join(" ");
	return { sql, params };
}

export async function queryChangeLog(
	db: D1Database,
	filter: ChangeLogFilter = {},
): Promise<ChangeLogEntry[]> {
	const { sql, params } = buildChangeLogQuery(filter);
	const { results } = await db
		.prepare(sql)
		.bind(...params)
		.all<ChangeLogRow>();
	return results.map(changeLogEntryFromRow);
}

interface DailyCountRow {
	from_agent_id: string;
	count: number;
}

interface ActiveTokenRow {
	id: string;
	agent_id: string;
	purpose: string;
	created_at: number;
}

function emptyActiveTokens(): Record<TokenPurpose, ActiveTokenSummary | null> {
	return {
		participant: null,
		admin: null,
		unread_count: null,
	};
}

export async function listAgentsWithStatus(
	db: D1Database,
	now: UnixMillis,
): Promise<AgentWithStatus[]> {
	const dayStart = utcDayStart(requireTime(now, "now"));
	const [agentResult, countResult, tokenResult] = await db.batch([
		db.prepare("SELECT * FROM agents ORDER BY name ASC, id ASC"),
		db
			.prepare(
				`SELECT from_agent_id, COUNT(*) AS count
				FROM messages
				WHERE kind = 'question' AND created_at >= ? AND created_at < ?
				GROUP BY from_agent_id`,
			)
			.bind(dayStart, dayStart + DAY_MS),
		db.prepare(
			`SELECT id, agent_id, purpose, created_at
			FROM tokens
			WHERE revoked_at IS NULL
			ORDER BY created_at ASC, id ASC`,
		),
	]);

	const countsByAgent = new Map<string, number>();
	for (const row of (countResult?.results ?? []) as DailyCountRow[]) {
		countsByAgent.set(row.from_agent_id, row.count);
	}

	const tokensByAgent = new Map<
		string,
		Record<TokenPurpose, ActiveTokenSummary | null>
	>();
	for (const row of (tokenResult?.results ?? []) as ActiveTokenRow[]) {
		const purpose = oneOf(TOKEN_PURPOSES, row.purpose, "tokens.purpose");
		let map = tokensByAgent.get(row.agent_id);
		if (map === undefined) {
			map = emptyActiveTokens();
			tokensByAgent.set(row.agent_id, map);
		}
		map[purpose] = {
			id: row.id,
			purpose,
			createdAt: row.created_at,
		};
	}

	return ((agentResult?.results ?? []) as AgentRow[]).map((row) => {
		const agent = agentFromRow(row);
		return {
			agent,
			todayQuestionCount: countsByAgent.get(agent.id) ?? 0,
			activeTokens: tokensByAgent.get(agent.id) ?? emptyActiveTokens(),
		};
	});
}

interface CategoryUsageRow {
	id: string;
	name: string;
	allow_rule_count: number;
}

export async function listCategoriesWithUsage(
	db: D1Database,
): Promise<CategoryWithUsage[]> {
	const { results } = await db
		.prepare(
			`SELECT c.id, c.name, COUNT(r.category_id) AS allow_rule_count
			FROM categories c
			LEFT JOIN allow_rules r ON r.category_id = c.id
			GROUP BY c.id, c.name
			ORDER BY c.name ASC, c.id ASC`,
		)
		.all<CategoryUsageRow>();
	return results.map((row) => ({
		category: { id: row.id, name: row.name },
		allowRuleCount: row.allow_rule_count,
	}));
}

interface JoinedAllowRuleRow {
	from_agent_id: string;
	from_agent_name: string;
	from_agent_status: string;
	to_agent_id: string;
	to_agent_name: string;
	to_agent_status: string;
	category_id: string;
	category_name: string;
	created_at: number;
}

export async function listAllowRulesGrouped(
	db: D1Database,
): Promise<AllowRuleGroup[]> {
	const { results } = await db
		.prepare(
			`SELECT
				r.from_agent_id,
				fa.name AS from_agent_name,
				fa.status AS from_agent_status,
				r.to_agent_id,
				ta.name AS to_agent_name,
				ta.status AS to_agent_status,
				r.category_id,
				c.name AS category_name,
				r.created_at
			FROM allow_rules r
			JOIN agents fa ON fa.id = r.from_agent_id
			JOIN agents ta ON ta.id = r.to_agent_id
			JOIN categories c ON c.id = r.category_id
			ORDER BY fa.name ASC, fa.id ASC, ta.name ASC, ta.id ASC, c.name ASC, c.id ASC`,
		)
		.all<JoinedAllowRuleRow>();

	const groups = new Map<string, AllowRuleGroup>();
	for (const row of results) {
		const key = `${row.from_agent_id}\0${row.to_agent_id}`;
		let group = groups.get(key);
		if (group === undefined) {
			group = {
				fromAgentId: row.from_agent_id,
				fromAgentName: row.from_agent_name,
				fromAgentStatus: oneOf<AgentStatus>(
					AGENT_STATUSES,
					row.from_agent_status,
					"agents.status",
				),
				toAgentId: row.to_agent_id,
				toAgentName: row.to_agent_name,
				toAgentStatus: oneOf<AgentStatus>(
					AGENT_STATUSES,
					row.to_agent_status,
					"agents.status",
				),
				categories: [],
			};
			groups.set(key, group);
		}
		group.categories.push({
			categoryId: row.category_id,
			categoryName: row.category_name,
			createdAt: row.created_at,
		});
	}
	return [...groups.values()];
}

export async function resolveDefaultOwnerId(db: D1Database): Promise<string> {
	const row = await db
		.prepare(
			"SELECT owner_id FROM agents ORDER BY created_at ASC, id ASC LIMIT 1",
		)
		.first<{ owner_id: string }>();
	return row?.owner_id ?? "me";
}
