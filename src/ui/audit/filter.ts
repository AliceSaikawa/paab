import { DEFAULT_AUDIT_QUERY_LIMIT, MAX_AUDIT_QUERY_LIMIT } from "../../audit";
import {
	AUDIT_OUTCOMES,
	type AuditOutcome,
	type UnixMillis,
} from "../../types";

export const DEFAULT_UI_AUDIT_LIMIT = DEFAULT_AUDIT_QUERY_LIMIT;
// Reserve 1 row for `limit + 1` lookahead so `buildAuditLogQuery` never clamps away the probe.
export const MAX_UI_AUDIT_LIMIT = MAX_AUDIT_QUERY_LIMIT - 1;

export interface RawAuditFormValues {
	readonly since: string;
	readonly before: string;
	readonly from: string;
	readonly to: string;
	readonly category: string;
	readonly outcome: string;
	readonly messageId: string;
	readonly limit: string;
	readonly showAuthFailed: boolean;
	readonly showBody: boolean;
}

export type AuditCursor =
	| { readonly kind: "latest" }
	| { readonly kind: "before"; readonly id: number }
	| { readonly kind: "after"; readonly id: number };

export interface ParsedAuditQuery {
	readonly occurredFrom?: UnixMillis;
	readonly occurredBefore?: UnixMillis;
	readonly fromAgentName?: string;
	readonly toAgentName?: string;
	readonly categoryName?: string;
	readonly outcome?: AuditOutcome;
	readonly messageId?: string;
	readonly showAuthFailed: boolean;
	readonly showBodyRequested: boolean;
	readonly limit: number;
	readonly cursor: AuditCursor;
	readonly raw: RawAuditFormValues;
}

export type AuditQueryParseResult =
	| { readonly ok: true; readonly query: ParsedAuditQuery }
	| {
			readonly ok: false;
			readonly error: string;
			readonly raw: RawAuditFormValues;
	  };

export interface AuditHrefOptions {
	readonly since?: string;
	readonly before?: string;
	readonly from?: string;
	readonly to?: string;
	readonly category?: string;
	readonly outcome?: string;
	readonly messageId?: string;
	readonly limit?: number;
	readonly showAuthFailed: boolean;
	readonly showBody: boolean;
	readonly cursor?: AuditCursor;
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$/;
const STRICT_UINT_PATTERN = /^\d+$/;

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

/**
 * Parses `YYYY-MM-DD`, HTML `datetime-local` (`YYYY-MM-DDTHH:MM[:SS[.sss]]`),
 * or ISO 8601 with an explicit offset (`Z` or `±HH:MM`) into UTC milliseconds.
 * Bare dates and offset-less `datetime-local` values use UTC.
 */
export function parseAuditTime(raw: string): UnixMillis | null {
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

function parseStrictUint(raw: string): number | null {
	if (!STRICT_UINT_PATTERN.test(raw)) {
		return null;
	}
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : null;
}

function readTrimmed(params: URLSearchParams, name: string): string {
	return (params.get(name) ?? "").trim();
}

function hasNul(value: string): boolean {
	return value.includes("\0");
}

/** Parses and validates `GET /admin/audit` query parameters. */
export function parseAuditSearchParams(
	searchParams: URLSearchParams,
): AuditQueryParseResult {
	const raw: RawAuditFormValues = {
		since: readTrimmed(searchParams, "since"),
		before: readTrimmed(searchParams, "before"),
		from: readTrimmed(searchParams, "from"),
		to: readTrimmed(searchParams, "to"),
		category: readTrimmed(searchParams, "category"),
		outcome: readTrimmed(searchParams, "outcome"),
		messageId: readTrimmed(searchParams, "message_id"),
		limit: readTrimmed(searchParams, "limit"),
		showAuthFailed: searchParams.get("show_auth_failed") === "1",
		showBody: searchParams.get("show_body") === "1",
	};

	const fail = (error: string): AuditQueryParseResult => ({
		ok: false,
		error,
		raw,
	});

	let occurredFrom: UnixMillis | undefined;
	if (raw.since !== "") {
		const parsed = parseAuditTime(raw.since);
		if (parsed === null) {
			return fail(
				`since の日時形式が不正です（例: 2026-11-16 または 2026-11-16T09:00+09:00）: ${raw.since}`,
			);
		}
		occurredFrom = parsed;
	}

	let occurredBefore: UnixMillis | undefined;
	if (raw.before !== "") {
		const parsed = parseAuditTime(raw.before);
		if (parsed === null) {
			return fail(
				`before の日時形式が不正です（例: 2026-11-17 または 2026-11-17T00:00Z）: ${raw.before}`,
			);
		}
		occurredBefore = parsed;
	}

	if (
		hasNul(raw.from) ||
		hasNul(raw.to) ||
		hasNul(raw.category) ||
		hasNul(raw.messageId)
	) {
		return fail("検索条件に NUL 文字は指定できません");
	}

	let outcome: AuditOutcome | undefined;
	if (raw.outcome !== "") {
		if (!(AUDIT_OUTCOMES as readonly string[]).includes(raw.outcome)) {
			return fail(
				`outcome は ${AUDIT_OUTCOMES.join(" / ")} のいずれかを指定してください: ${raw.outcome}`,
			);
		}
		outcome = raw.outcome as AuditOutcome;
	}

	let limit = DEFAULT_UI_AUDIT_LIMIT;
	if (raw.limit !== "") {
		const parsed = parseStrictUint(raw.limit);
		if (parsed === null || parsed < 1) {
			return fail(`limit は 1 以上の整数で指定してください: ${raw.limit}`);
		}
		limit = Math.min(parsed, MAX_UI_AUDIT_LIMIT);
	}

	const rawBeforeId = readTrimmed(searchParams, "before_id");
	const rawAfterId = readTrimmed(searchParams, "after_id");
	if (rawBeforeId !== "" && rawAfterId !== "") {
		return fail("before_id と after_id は同時に指定できません");
	}

	let cursor: AuditCursor = { kind: "latest" };
	if (rawBeforeId !== "") {
		const id = parseStrictUint(rawBeforeId);
		if (id === null) {
			return fail(
				`before_id は 0 以上の整数で指定してください: ${rawBeforeId}`,
			);
		}
		cursor = { kind: "before", id };
	} else if (rawAfterId !== "") {
		const id = parseStrictUint(rawAfterId);
		if (id === null) {
			return fail(`after_id は 0 以上の整数で指定してください: ${rawAfterId}`);
		}
		cursor = { kind: "after", id };
	}

	return {
		ok: true,
		query: {
			occurredFrom,
			occurredBefore,
			fromAgentName: raw.from || undefined,
			toAgentName: raw.to || undefined,
			categoryName: raw.category || undefined,
			outcome,
			messageId: raw.messageId || undefined,
			showAuthFailed: raw.showAuthFailed,
			showBodyRequested: raw.showBody,
			limit,
			cursor,
			raw,
		},
	};
}

/** Builds a `/admin/audit` URL preserving active filters and an optional cursor. */
export function buildAuditHref(options: AuditHrefOptions): string {
	const params = new URLSearchParams();
	if (options.since) {
		params.set("since", options.since);
	}
	if (options.before) {
		params.set("before", options.before);
	}
	if (options.from) {
		params.set("from", options.from);
	}
	if (options.to) {
		params.set("to", options.to);
	}
	if (options.category) {
		params.set("category", options.category);
	}
	if (options.outcome) {
		params.set("outcome", options.outcome);
	}
	if (options.messageId) {
		params.set("message_id", options.messageId);
	}
	if (options.showAuthFailed) {
		params.set("show_auth_failed", "1");
	}
	if (options.showBody) {
		params.set("show_body", "1");
	}
	if (options.limit !== undefined && options.limit !== DEFAULT_UI_AUDIT_LIMIT) {
		params.set("limit", String(options.limit));
	}
	if (options.cursor?.kind === "before") {
		params.set("before_id", String(options.cursor.id));
	} else if (options.cursor?.kind === "after") {
		params.set("after_id", String(options.cursor.id));
	}
	const qs = params.toString();
	return qs.length > 0 ? `/admin/audit?${qs}` : "/admin/audit";
}
