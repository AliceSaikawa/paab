const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Default retention period in days for audit log metadata rows (design 4).
 * Set `AUDIT_LOG_RETENTION_DAYS=0` to retain rows indefinitely.
 */
export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365;

/**
 * Settings for recording message bodies in the audit log (design section 4).
 * Bodies are not recorded by default. When recording is on, a retention
 * period is mandatory.
 */
export interface AuditBodyConfig {
	/** Whether message bodies are written to the audit log. */
	recordBodies: boolean;
	/**
	 * How many days a recorded body is kept, counted from the time of the
	 * event. Ignored while `recordBodies` is false.
	 */
	bodyRetentionDays: number;
}

/** The default: no bodies in the audit log. */
export const AUDIT_BODY_RECORDING_DISABLED: AuditBodyConfig = Object.freeze({
	recordBodies: false,
	bodyRetentionDays: 0,
});

/**
 * True only when recording is on and the retention period is a positive
 * whole number of days. Anything else counts as off, so that a body is never
 * stored without a deadline for its removal.
 */
export function isBodyRecordingEnabled(config: AuditBodyConfig): boolean {
	return (
		config.recordBodies === true &&
		Number.isSafeInteger(config.bodyRetentionDays) &&
		config.bodyRetentionDays > 0
	);
}

function parseFlag(value: unknown): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function parseDays(value: unknown): number | null {
	let days: number;
	if (typeof value === "number") {
		days = value;
	} else if (typeof value === "string" && /^\s*[0-9]+\s*$/.test(value)) {
		days = Number(value);
	} else {
		return null;
	}
	return Number.isSafeInteger(days) && days > 0 ? days : null;
}

/**
 * Builds the configuration from raw variable values, such as the strings in
 * the `vars` of `wrangler.jsonc`. Recording is on only when `recordBodies`
 * is `true` (or the string "true") and `bodyRetentionDays` is a positive
 * whole number (or a string of digits). Every other input, including a
 * missing or malformed value, yields the disabled configuration.
 */
export function parseAuditBodyConfig(raw: {
	recordBodies?: unknown;
	bodyRetentionDays?: unknown;
}): AuditBodyConfig {
	const days = parseDays(raw.bodyRetentionDays);
	if (!parseFlag(raw.recordBodies) || days === null) {
		return AUDIT_BODY_RECORDING_DISABLED;
	}
	return { recordBodies: true, bodyRetentionDays: days };
}

/**
 * Parses `AUDIT_LOG_RETENTION_DAYS` into a non-negative whole number of days.
 * - `0` / `"0"`: retain audit log metadata rows indefinitely.
 * - Positive whole number (whose millisecond span is a safe integer): delete
 *   rows once `occurred_at <= now - days * DAY_MS`.
 * - Missing, empty, or malformed values fall back to
 *   `DEFAULT_AUDIT_LOG_RETENTION_DAYS`.
 */
export function parseAuditLogRetentionDays(value: unknown): number {
	if (value === undefined || value === null) {
		return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
	}
	if (typeof value === "string" && value.trim() === "") {
		return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
	}
	let days: number;
	if (typeof value === "number") {
		days = value;
	} else if (typeof value === "string" && /^\s*[0-9]+\s*$/.test(value)) {
		days = Number(value);
	} else {
		return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
	}
	if (
		!Number.isSafeInteger(days) ||
		days < 0 ||
		!Number.isSafeInteger(days * DAY_MS)
	) {
		return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
	}
	return days;
}
