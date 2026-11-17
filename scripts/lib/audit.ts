import {
	type AuditLogFilter,
	type AuditLogView,
	type AuditLogViewRow,
	auditLogViewFromRow,
	buildAuditLogQuery,
	inlineAuditLogQuery,
} from "../../src/audit/query";
import { AUDIT_OUTCOMES, type AuditOutcome } from "../../src/types";
import { CliError, type D1Client } from "./sql";

/** The audit log options as typed on the command line. */
export interface AuditLogOptions {
	since?: string;
	before?: string;
	from?: string;
	to?: string;
	category?: string;
	outcome?: string;
	limit?: string;
	body?: boolean;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_WITH_OFFSET =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses `2026-11-01` as local midnight, or a date and time that names its
 * offset (`2026-11-01T09:00+09:00`, `...Z`). A time without an offset is
 * refused rather than guessed.
 */
export function parseTime(value: string, option: string): number {
	const date = DATE_ONLY.exec(value);
	const millis = date
		? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime()
		: DATE_TIME_WITH_OFFSET.test(value)
			? Date.parse(value)
			: Number.NaN;
	if (Number.isNaN(millis)) {
		throw new CliError(
			`--${option} には 2026-11-01 か 2026-11-01T09:00+09:00 の形で日時を指定してください: ${value}`,
		);
	}
	return millis;
}

/** Turns command line options into the filter `#6` reads the log with. */
export function auditLogFilter(options: AuditLogOptions): AuditLogFilter {
	const filter: AuditLogFilter = {
		fromAgentName: options.from,
		toAgentName: options.to,
		categoryName: options.category,
		includeBody: options.body === true,
	};
	if (options.since !== undefined) {
		filter.occurredFrom = parseTime(options.since, "since");
	}
	if (options.before !== undefined) {
		filter.occurredBefore = parseTime(options.before, "before");
	}
	if (options.outcome !== undefined) {
		if (!(AUDIT_OUTCOMES as readonly string[]).includes(options.outcome)) {
			throw new CliError(
				`--outcome には ${AUDIT_OUTCOMES.join("、")} のいずれかを指定してください: ${options.outcome}`,
			);
		}
		filter.outcome = options.outcome as AuditOutcome;
	}
	if (options.limit !== undefined) {
		const limit = Number(options.limit);
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new CliError(
				`--limit には 1 以上の整数を指定してください: ${options.limit}`,
			);
		}
		filter.limit = limit;
	}
	return filter;
}

/** Reads the log with the same query `queryAuditLog` runs on a binding. */
export async function readAuditLog(
	db: D1Client,
	filter: AuditLogFilter,
): Promise<AuditLogView[]> {
	const rows = await db.query(inlineAuditLogQuery(buildAuditLogQuery(filter)));
	return rows.map((row) =>
		auditLogViewFromRow(row as unknown as AuditLogViewRow),
	);
}

/** Formats UNIX milliseconds as local time with its offset. */
export function formatTime(millis: number): string {
	const date = new Date(millis);
	const offset = -date.getTimezoneOffset();
	const local = new Date(millis + offset * 60_000).toISOString().slice(0, 19);
	const sign = offset < 0 ? "-" : "+";
	const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
	const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
	return `${local}${sign}${hours}:${minutes}`;
}

/**
 * Renders entries as tab-separated lines under a header, so the output both
 * reads in a terminal and pipes into other tools. Agents and categories show
 * by name, or by ID once they no longer exist.
 */
export function formatAuditLog(
	entries: AuditLogView[],
	includeBody: boolean,
): string {
	const header = [
		"occurred_at",
		"event_type",
		"from",
		"to",
		"category",
		"outcome",
		"reason_code",
		"message_id",
		...(includeBody ? ["body"] : []),
	];
	const lines = entries.map((entry) =>
		[
			formatTime(entry.occurredAt),
			entry.eventType,
			entry.fromAgentName ?? entry.fromAgentId ?? "-",
			entry.toAgentName ?? entry.toAgentId ?? "-",
			entry.categoryName ?? entry.categoryId ?? "-",
			entry.outcome,
			entry.reasonCode ?? "-",
			entry.messageId ?? "-",
			...(includeBody
				? [entry.body === null ? "-" : JSON.stringify(entry.body)]
				: []),
		].join("\t"),
	);
	return [header.join("\t"), ...lines].join("\n");
}
