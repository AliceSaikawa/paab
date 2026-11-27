import { z } from "zod";
import {
	type AuditBodyConfig,
	type AuditLogFilter,
	type AuditLogView,
	DEFAULT_AUDIT_QUERY_LIMIT,
	MAX_AUDIT_QUERY_LIMIT,
	queryAuditLog,
} from "../audit";
import { type Frame, renderFramed } from "../mcp/frame";
import {
	type AdminBotConfig,
	type Agent,
	AUDIT_OUTCOMES,
	type ReasonCode,
	type UnixMillis,
} from "../types";

/** Request-scoped context passed to every `/mcp/admin` tool. */
export interface AdminMcpContext {
	db: D1Database;
	agent: Agent;
	config: AdminBotConfig;
	audit: AuditBodyConfig;
	now: UnixMillis;
}

export interface AdminToolAudit {
	toAgentId?: string | null;
	categoryId?: string | null;
	messageId?: string | null;
	deniedReason?: ReasonCode;
}

export interface AdminToolOutput {
	text: string;
	isError: boolean;
	audit?: AdminToolAudit;
}

export interface AdminToolDefinition<Input extends z.ZodObject = z.ZodObject> {
	name: string;
	description: string;
	inputSchema: Input;
	run(ctx: AdminMcpContext, args: z.infer<Input>): Promise<AdminToolOutput>;
}

/** Infers the argument type of `run` from `inputSchema`. */
export function defineAdminTool<Input extends z.ZodObject>(
	tool: AdminToolDefinition<Input>,
): AdminToolDefinition<Input> {
	return tool;
}

export function adminToolOk(
	text: string,
	audit?: Omit<AdminToolAudit, "deniedReason">,
): AdminToolOutput {
	return audit === undefined
		? { text, isError: false }
		: { text, isError: false, audit };
}

export function adminToolFail(
	text: string,
	audit?: AdminToolAudit,
): AdminToolOutput {
	return audit === undefined
		? { text, isError: true }
		: { text, isError: true, audit };
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$/;

function validatedUtcMillis(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	ms: number,
): number | null {
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour < 0 ||
		hour > 23 ||
		minute < 0 ||
		minute > 59 ||
		second < 0 ||
		second > 59
	) {
		return null;
	}
	const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
	const check = new Date(utc);
	if (
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== day ||
		check.getUTCHours() !== hour ||
		check.getUTCMinutes() !== minute ||
		check.getUTCSeconds() !== second ||
		check.getUTCMilliseconds() !== ms
	) {
		return null;
	}
	return utc;
}

function parseAuditTimestamp(raw: string): UnixMillis | null {
	const value = raw.trim();
	const dateMatch = DATE_ONLY_PATTERN.exec(value);
	if (dateMatch !== null) {
		return validatedUtcMillis(
			Number(dateMatch[1]),
			Number(dateMatch[2]),
			Number(dateMatch[3]),
			0,
			0,
			0,
			0,
		);
	}
	const dtMatch = DATE_TIME_PATTERN.exec(value);
	if (dtMatch === null) {
		return null;
	}
	const frac = dtMatch[7];
	const ms = frac !== undefined ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
	const base = validatedUtcMillis(
		Number(dtMatch[1]),
		Number(dtMatch[2]),
		Number(dtMatch[3]),
		Number(dtMatch[4]),
		Number(dtMatch[5]),
		dtMatch[6] !== undefined ? Number(dtMatch[6]) : 0,
		ms,
	);
	if (base === null) {
		return null;
	}
	const zone = dtMatch[8];
	if (zone === undefined || zone === "Z") {
		return base;
	}
	const sign = zone[0] === "+" ? 1 : -1;
	const offHour = Number(zone.slice(1, 3));
	const offMin = Number(zone.slice(4, 6));
	if (offHour > 23 || offMin > 59) {
		return null;
	}
	return base - sign * (offHour * 60 + offMin) * 60_000;
}

function normalizeOptionalFilterText(
	raw: string | undefined,
	field: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
	if (raw === undefined) {
		return { ok: true, value: undefined };
	}
	if (raw.includes("\0")) {
		return { ok: false, error: `${field} must not contain NUL characters` };
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { ok: false, error: `${field} must not be empty` };
	}
	return { ok: true, value: trimmed };
}

function renderLabeledExternalName(
	label: string,
	name: string | null,
	frame: Frame,
): string {
	if (name === null) {
		return `${label}: -`;
	}
	return `${label}:\n${frame(name)}`;
}

function renderAuditEntry(entry: AuditLogView, frame: Frame): string {
	return [
		`id: ${entry.id}`,
		`occurred_at: ${new Date(entry.occurredAt).toISOString()}`,
		`event_type: ${entry.eventType}`,
		`outcome: ${entry.outcome}`,
		`reason_code: ${entry.reasonCode ?? "-"}`,
		`message_id: ${entry.messageId ?? "-"}`,
		`from_id: ${entry.fromAgentId ?? "-"}`,
		renderLabeledExternalName("from_name", entry.fromAgentName, frame),
		`to_id: ${entry.toAgentId ?? "-"}`,
		renderLabeledExternalName("to_name", entry.toAgentName, frame),
		`category_id: ${entry.categoryId ?? "-"}`,
		renderLabeledExternalName("category_name", entry.categoryName, frame),
	].join("\n");
}

const viewAuditLog = defineAdminTool({
	name: "view_audit_log",
	description:
		"Read bridge audit log metadata (without message bodies) with optional filters and cursor pagination.",
	inputSchema: z.object({
		since: z
			.string()
			.optional()
			.describe(
				"Entries at or after this time (YYYY-MM-DD in UTC, or ISO 8601 with offset like 2026-11-16T09:00+09:00).",
			),
		before: z
			.string()
			.optional()
			.describe(
				"Entries strictly before this time (YYYY-MM-DD in UTC, or ISO 8601 with offset).",
			),
		from: z.string().optional().describe("Asking agent name."),
		to: z.string().optional().describe("Recipient agent name."),
		category: z.string().optional().describe("Category name."),
		outcome: z
			.enum(AUDIT_OUTCOMES)
			.optional()
			.describe("Audit outcome: ok, denied, or expired."),
		message_id: z.string().optional().describe("Exact message/question ID."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_AUDIT_QUERY_LIMIT)
			.optional()
			.describe(
				`Maximum entries to return (1-${MAX_AUDIT_QUERY_LIMIT}, default ${DEFAULT_AUDIT_QUERY_LIMIT}).`,
			),
		before_id: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("Return entries with ID strictly less than this cursor."),
		after_id: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("Return entries with ID strictly greater than this cursor."),
		oldest: z
			.boolean()
			.optional()
			.describe("Return oldest entries first instead of newest first."),
	}),
	async run(ctx, args) {
		let occurredFrom: UnixMillis | undefined;
		if (args.since !== undefined) {
			const parsed = parseAuditTimestamp(args.since);
			if (parsed === null) {
				return adminToolFail(`invalid since timestamp: ${args.since}`);
			}
			occurredFrom = parsed;
		}

		let occurredBefore: UnixMillis | undefined;
		if (args.before !== undefined) {
			const parsed = parseAuditTimestamp(args.before);
			if (parsed === null) {
				return adminToolFail(`invalid before timestamp: ${args.before}`);
			}
			occurredBefore = parsed;
		}

		const fromCheck = normalizeOptionalFilterText(args.from, "from");
		if (!fromCheck.ok) return adminToolFail(fromCheck.error);
		const toCheck = normalizeOptionalFilterText(args.to, "to");
		if (!toCheck.ok) return adminToolFail(toCheck.error);
		const categoryCheck = normalizeOptionalFilterText(
			args.category,
			"category",
		);
		if (!categoryCheck.ok) return adminToolFail(categoryCheck.error);
		const messageIdCheck = normalizeOptionalFilterText(
			args.message_id,
			"message_id",
		);
		if (!messageIdCheck.ok) return adminToolFail(messageIdCheck.error);

		const limit = args.limit ?? DEFAULT_AUDIT_QUERY_LIMIT;
		const order = args.oldest === true ? "asc" : "desc";
		const baseFilter: AuditLogFilter = {
			occurredFrom,
			occurredBefore,
			fromAgentName: fromCheck.value,
			toAgentName: toCheck.value,
			categoryName: categoryCheck.value,
			outcome: args.outcome,
			messageId: messageIdCheck.value,
			beforeId: args.before_id,
			afterId: args.after_id,
			order,
			// Body inspection is out of scope for #34 and requires the read_bodies switch.
			includeBody: false,
		};

		let entries: AuditLogView[];
		let hasMore = false;
		if (limit < MAX_AUDIT_QUERY_LIMIT) {
			const rows = await queryAuditLog(ctx.db, {
				...baseFilter,
				limit: limit + 1,
			});
			hasMore = rows.length > limit;
			entries = rows.slice(0, limit);
		} else {
			entries = await queryAuditLog(ctx.db, { ...baseFilter, limit });
			const last = entries.at(-1);
			if (entries.length === limit && last !== undefined) {
				const probe = await queryAuditLog(ctx.db, {
					...baseFilter,
					beforeId: order === "desc" ? last.id : args.before_id,
					afterId: order === "asc" ? last.id : args.after_id,
					limit: 1,
				});
				hasMore = probe.length > 0;
			}
		}

		if (entries.length === 0) {
			return adminToolOk("no matching audit log entries");
		}

		const lastEntry = entries.at(-1);
		const cursorLine =
			hasMore && lastEntry !== undefined
				? order === "desc"
					? `next_before_id: ${lastEntry.id}`
					: `next_after_id: ${lastEntry.id}`
				: null;

		return adminToolOk(
			renderFramed((frame) => {
				const header = [
					`entries: ${entries.length}`,
					`order: ${order}`,
					`has_more: ${hasMore}`,
					...(cursorLine !== null ? [cursorLine] : []),
				].join("\n");
				return [
					header,
					...entries.map((entry) => renderAuditEntry(entry, frame)),
				].join("\n\n");
			}),
		);
	},
});

export const ADMIN_TOOLS: readonly AdminToolDefinition[] = [viewAuditLog];
