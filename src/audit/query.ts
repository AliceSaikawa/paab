import { type AuditLogRow, auditLogEntryFromRow } from "../db";
import {
	AUDIT_OUTCOMES,
	type AuditLogEntry,
	type AuditOutcome,
	type UnixMillis,
} from "../types";

export const DEFAULT_AUDIT_QUERY_LIMIT = 100;
export const MAX_AUDIT_QUERY_LIMIT = 1000;

/**
 * Conditions for reading the audit log. Every condition is optional, and the
 * given ones must all hold.
 *
 * Agents and categories can be named by ID or by name. A name is resolved
 * against the current `agents` and `categories` tables, so entries about a
 * deleted agent or category can only be found by ID.
 */
export interface AuditLogFilter {
	/** Entries at or after this time. */
	occurredFrom?: UnixMillis;
	/** Entries strictly before this time. */
	occurredBefore?: UnixMillis;
	/** The asking agent, by ID. */
	fromAgentId?: string;
	/** The asking agent, by name. */
	fromAgentName?: string;
	/** The agent that was asked, by ID. */
	toAgentId?: string;
	/** The agent that was asked, by name. */
	toAgentName?: string;
	categoryId?: string;
	categoryName?: string;
	outcome?: AuditOutcome;
	/**
	 * Maximum number of entries, oldest first. Defaults to
	 * `DEFAULT_AUDIT_QUERY_LIMIT`; at most `MAX_AUDIT_QUERY_LIMIT`.
	 */
	limit?: number;
	/**
	 * Whether to return recorded bodies. Off by default, in which case `body`
	 * is null in every result.
	 */
	includeBody?: boolean;
}

/** A SQL statement with `?` placeholders and the values to bind, in order. */
export interface AuditLogQuery {
	sql: string;
	params: (string | number)[];
}

/** An audit log row joined with the current names of what it refers to. */
export interface AuditLogViewRow extends AuditLogRow {
	from_agent_name: string | null;
	to_agent_name: string | null;
	category_name: string | null;
}

/**
 * An audit log entry with the current names of its agents and category. A
 * name is null when the ID is null or no longer exists.
 */
export interface AuditLogView extends AuditLogEntry {
	fromAgentName: string | null;
	toAgentName: string | null;
	categoryName: string | null;
}

function requireTime(value: number, name: string): number {
	if (!Number.isSafeInteger(value)) {
		throw new RangeError(`${name} must be an integer of UNIX milliseconds`);
	}
	return value;
}

function requireText(value: string, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new RangeError(`${name} must be a non-empty string`);
	}
	return value;
}

/**
 * Builds the SELECT for a filter without touching a database. Throws a
 * `RangeError` on a malformed filter.
 *
 * Results are ordered by `occurred_at, id`. The columns are those of
 * `AuditLogViewRow`; convert rows with `auditLogViewFromRow`.
 */
export function buildAuditLogQuery(filter: AuditLogFilter = {}): AuditLogQuery {
	const where: string[] = [];
	const params: (string | number)[] = [];
	const add = (condition: string, value: string | number) => {
		where.push(condition);
		params.push(value);
	};

	if (filter.occurredFrom !== undefined) {
		add("l.occurred_at >= ?", requireTime(filter.occurredFrom, "occurredFrom"));
	}
	if (filter.occurredBefore !== undefined) {
		add(
			"l.occurred_at < ?",
			requireTime(filter.occurredBefore, "occurredBefore"),
		);
	}
	if (filter.fromAgentId !== undefined) {
		add("l.from_agent_id = ?", requireText(filter.fromAgentId, "fromAgentId"));
	}
	if (filter.fromAgentName !== undefined) {
		add("fa.name = ?", requireText(filter.fromAgentName, "fromAgentName"));
	}
	if (filter.toAgentId !== undefined) {
		add("l.to_agent_id = ?", requireText(filter.toAgentId, "toAgentId"));
	}
	if (filter.toAgentName !== undefined) {
		add("ta.name = ?", requireText(filter.toAgentName, "toAgentName"));
	}
	if (filter.categoryId !== undefined) {
		add("l.category_id = ?", requireText(filter.categoryId, "categoryId"));
	}
	if (filter.categoryName !== undefined) {
		add("c.name = ?", requireText(filter.categoryName, "categoryName"));
	}
	if (filter.outcome !== undefined) {
		if (!(AUDIT_OUTCOMES as readonly string[]).includes(filter.outcome)) {
			throw new RangeError(
				`outcome must be one of: ${AUDIT_OUTCOMES.join(", ")}`,
			);
		}
		add("l.outcome = ?", filter.outcome);
	}

	const limit = filter.limit ?? DEFAULT_AUDIT_QUERY_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError("limit must be a positive integer");
	}
	params.push(Math.min(limit, MAX_AUDIT_QUERY_LIMIT));

	const body = filter.includeBody === true ? "l.body" : "NULL";
	const sql = [
		"SELECT l.id, l.occurred_at, l.event_type, l.from_agent_id, l.to_agent_id,",
		`l.category_id, l.outcome, l.reason_code, l.message_id, ${body} AS body,`,
		"fa.name AS from_agent_name, ta.name AS to_agent_name, c.name AS category_name",
		"FROM audit_log AS l",
		"LEFT JOIN agents AS fa ON fa.id = l.from_agent_id",
		"LEFT JOIN agents AS ta ON ta.id = l.to_agent_id",
		"LEFT JOIN categories AS c ON c.id = l.category_id",
		...(where.length > 0 ? [`WHERE ${where.join(" AND ")}`] : []),
		"ORDER BY l.occurred_at, l.id",
		"LIMIT ?",
	].join(" ");
	return { sql, params };
}

/**
 * Renders a query as one SQL string with the values written in as literals,
 * for tools that cannot bind parameters (`wrangler d1 execute --command`).
 * Prefer binding wherever it is available.
 */
export function inlineAuditLogQuery(query: AuditLogQuery): string {
	const parts = query.sql.split("?");
	if (parts.length !== query.params.length + 1) {
		throw new Error("placeholder count does not match the number of values");
	}
	let sql = parts[0] ?? "";
	query.params.forEach((value, index) => {
		sql += sqlLiteral(value) + (parts[index + 1] ?? "");
	});
	return sql;
}

function sqlLiteral(value: string | number): string {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) {
			throw new RangeError("numeric values must be integers");
		}
		return String(value);
	}
	if (value.includes("\0")) {
		throw new RangeError("text values must not contain a NUL character");
	}
	return `'${value.replaceAll("'", "''")}'`;
}

export function auditLogViewFromRow(row: AuditLogViewRow): AuditLogView {
	return {
		...auditLogEntryFromRow(row),
		fromAgentName: row.from_agent_name,
		toAgentName: row.to_agent_name,
		categoryName: row.category_name,
	};
}

/**
 * Reads audit log entries that match the filter, ordered by time and then by
 * ID. Rejects on a malformed filter or a database failure.
 */
export async function queryAuditLog(
	db: D1Database,
	filter: AuditLogFilter = {},
): Promise<AuditLogView[]> {
	const { sql, params } = buildAuditLogQuery(filter);
	const { results } = await db
		.prepare(sql)
		.bind(...params)
		.all<AuditLogViewRow>();
	return results.map(auditLogViewFromRow);
}
