import { insertAuditLogEntry } from "../db";
import {
	AUDIT_EVENT_TYPES,
	type AuditEventType,
	type AuditOutcome,
	type NewAuditLogEntry,
	REASON_CODES,
	type ReasonCode,
	type UnixMillis,
} from "../types";
import { type AuditBodyConfig, isBodyRecordingEnabled } from "./config";

/** Event types that record a denial by the bridge and so carry a reason. */
export type DeniedByBridgeEventType =
	| "question_blocked"
	| "auth_failed"
	| "admin_tool_denied"
	| "webhook_abandoned";

interface AuditEventBase {
	/** When the event happened. The caller passes the time in. */
	occurredAt: UnixMillis;
	/**
	 * The agent that asked the question, for every event type. On
	 * `question_answered` and `question_declined` this is still the asker,
	 * not the agent that replied, so that one filter by sender returns the
	 * whole history of a question.
	 */
	fromAgentId?: string | null;
	/** The agent the question was addressed to, for every event type. */
	toAgentId?: string | null;
	categoryId?: string | null;
	/** The ID of the question the event is about. */
	messageId?: string | null;
	/**
	 * The question or answer text. It is stored only while body recording is
	 * enabled; otherwise it is dropped here.
	 */
	body?: string | null;
}

/**
 * One thing to record. Denials by the bridge must say why; the reason stays
 * in the audit log and is never shown to the asking agent (design 3.4).
 */
export type AuditEvent =
	| (AuditEventBase & {
			eventType: DeniedByBridgeEventType;
			reasonCode: ReasonCode;
	  })
	| (AuditEventBase & {
			eventType: Exclude<AuditEventType, DeniedByBridgeEventType>;
			reasonCode?: null;
	  });

const OUTCOMES: Record<AuditEventType, AuditOutcome> = {
	question_accepted: "ok",
	question_blocked: "denied",
	question_delivered: "ok",
	question_answered: "ok",
	question_declined: "denied",
	question_expired: "expired",
	auth_failed: "denied",
	admin_tool_called: "ok",
	admin_tool_denied: "denied",
	admin_body_read: "ok",
	description_submitted: "ok",
	webhook_delivered: "ok",
	webhook_abandoned: "denied",
};

/** The outcome an event type is recorded with. */
export function outcomeOf(eventType: AuditEventType): AuditOutcome {
	return OUTCOMES[eventType];
}

/**
 * Turns an event into the row to insert. Throws on values the audit log does
 * not know, because the table has no CHECK constraint on them.
 */
export function buildAuditLogEntry(
	config: AuditBodyConfig,
	event: AuditEvent,
): NewAuditLogEntry {
	if (!(AUDIT_EVENT_TYPES as readonly string[]).includes(event.eventType)) {
		throw new Error("unknown audit event type");
	}
	const reasonCode = event.reasonCode ?? null;
	if (
		reasonCode !== null &&
		!(REASON_CODES as readonly string[]).includes(reasonCode)
	) {
		throw new Error("unknown audit reason code");
	}
	if (!Number.isSafeInteger(event.occurredAt)) {
		throw new Error("occurredAt must be an integer of UNIX milliseconds");
	}
	const body =
		isBodyRecordingEnabled(config) && typeof event.body === "string"
			? event.body
			: null;
	return {
		occurredAt: event.occurredAt,
		eventType: event.eventType,
		fromAgentId: event.fromAgentId ?? null,
		toAgentId: event.toAgentId ?? null,
		categoryId: event.categoryId ?? null,
		outcome: outcomeOf(event.eventType),
		reasonCode,
		messageId: event.messageId ?? null,
		body,
	};
}

/** Bodies to keep out of console output. */
type MaybeBody = string | null | undefined;

/**
 * Describes a failure for the console without the message bodies. Workers
 * Logs keep console output, so nothing here may carry user content.
 */
function describeFailure(
	error: unknown,
	bodies: MaybeBody | MaybeBody[],
): string {
	let message = error instanceof Error ? error.message : String(error);
	for (const body of Array.isArray(bodies) ? bodies : [bodies]) {
		if (typeof body === "string" && body.length > 0) {
			message = message.split(body).join("[body]");
		}
	}
	return message;
}

/**
 * Records one event in the audit log.
 *
 * It never throws and never rejects: a failed write must not change whether
 * the surrounding operation is allowed or denied. A failure is reported on
 * the console and as a `false` return value. Do not put this write in the
 * same `db.batch` as the operation it describes, or a failure here would
 * roll that operation back.
 */
export async function recordAuditEvent(
	db: D1Database,
	config: AuditBodyConfig,
	event: AuditEvent,
): Promise<boolean> {
	try {
		await insertAuditLogEntry(db, buildAuditLogEntry(config, event)).run();
		return true;
	} catch (error) {
		try {
			console.error("audit log write failed", {
				eventType: String(event?.eventType),
				messageId: event?.messageId ?? null,
				error: describeFailure(error, event?.body),
			});
		} catch {
			// Reporting must not throw either.
		}
		return false;
	}
}

/**
 * Events written per `db.batch` call, so that one call stays a single
 * statement batch even for a long backlog. Matches the chunk the expiry
 * sweep closes questions with.
 */
export const AUDIT_WRITE_CHUNK = 25;

/**
 * Records several events with one `db.batch` per `AUDIT_WRITE_CHUNK` events,
 * instead of one statement per event. D1 caps the statements a Worker
 * invocation may run (50 on Workers Free), so per-event writes let a full
 * inbox or a long expiry backlog push a request over the limit.
 *
 * The same contract as `recordAuditEvent`: never throws or rejects, a
 * failed write is reported on the console and as a `false` return value,
 * and the batch never shares a `db.batch` with the operation it describes.
 * The events of one call share a fate: when a batch fails, its remaining
 * events are not written.
 */
export async function recordAuditEvents(
	db: D1Database,
	config: AuditBodyConfig,
	events: AuditEvent[],
): Promise<boolean> {
	if (events.length === 0) {
		return true;
	}
	let failedFrom = 0;
	try {
		const statements = events.map((event) =>
			insertAuditLogEntry(db, buildAuditLogEntry(config, event)),
		);
		for (let i = 0; i < statements.length; i += AUDIT_WRITE_CHUNK) {
			failedFrom = i;
			await db.batch(statements.slice(i, i + AUDIT_WRITE_CHUNK));
		}
		return true;
	} catch (error) {
		const unwritten = events.slice(failedFrom);
		try {
			console.error("audit log write failed", {
				eventTypes: unwritten.map((event) => String(event?.eventType)),
				messageIds: unwritten.map((event) => event?.messageId ?? null),
				error: describeFailure(
					error,
					unwritten.map((event) => event?.body),
				),
			});
		} catch {
			// Reporting must not throw either.
		}
		return false;
	}
}

export interface DailyLimitBlockedAuditEvent {
	occurredAt: UnixMillis;
	fromAgentId: string;
	toAgentId?: string | null;
	categoryId?: string | null;
	messageId?: string | null;
}

/**
 * Records at most one `question_blocked` (`daily_limit_exceeded`) audit row
 * per agent within `[dayStart, dayEnd)`. Checks with a read-only `SELECT`
 * first so repeat over-limit calls perform zero D1 writes, and guards the
 * insert with `WHERE NOT EXISTS` against concurrent first hits.
 *
 * Follows `recordAuditEvent`: never throws or rejects. Returns `true` when
 * a new row was written and `false` when suppressed or on error.
 */
export async function recordDailyLimitBlockedAudit(
	db: D1Database,
	config: AuditBodyConfig,
	event: DailyLimitBlockedAuditEvent,
	dayStart: UnixMillis,
	dayEnd: UnixMillis,
): Promise<boolean> {
	try {
		if (!Number.isSafeInteger(dayStart) || !Number.isSafeInteger(dayEnd)) {
			throw new Error(
				"dayStart and dayEnd must be integers of UNIX milliseconds",
			);
		}
		const entry = buildAuditLogEntry(config, {
			eventType: "question_blocked",
			occurredAt: event.occurredAt,
			fromAgentId: event.fromAgentId,
			toAgentId: event.toAgentId,
			categoryId: event.categoryId,
			reasonCode: "daily_limit_exceeded",
			messageId: event.messageId,
		});
		const existing = await db
			.prepare(
				`SELECT 1 AS found FROM audit_log
				WHERE occurred_at >= ? AND occurred_at < ?
					AND event_type = 'question_blocked'
					AND from_agent_id = ?
					AND reason_code = 'daily_limit_exceeded'
				LIMIT 1`,
			)
			.bind(dayStart, dayEnd, entry.fromAgentId)
			.first<{ found: number }>();
		if (existing !== null) {
			return false;
		}
		const result = await db
			.prepare(
				`INSERT INTO audit_log
					(occurred_at, event_type, from_agent_id, to_agent_id, category_id,
					outcome, reason_code, message_id, body)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				WHERE NOT EXISTS (
					SELECT 1 FROM audit_log
					WHERE occurred_at >= ? AND occurred_at < ?
						AND event_type = 'question_blocked'
						AND from_agent_id = ?
						AND reason_code = 'daily_limit_exceeded'
				)`,
			)
			.bind(
				entry.occurredAt,
				entry.eventType,
				entry.fromAgentId,
				entry.toAgentId,
				entry.categoryId,
				entry.outcome,
				entry.reasonCode,
				entry.messageId,
				entry.body,
				dayStart,
				dayEnd,
				entry.fromAgentId,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	} catch (error) {
		try {
			console.error("audit log write failed", {
				eventType: "question_blocked",
				messageId: event?.messageId ?? null,
				error: describeFailure(error, null),
			});
		} catch {
			// Reporting must not throw either.
		}
		return false;
	}
}
