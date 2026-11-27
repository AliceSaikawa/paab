import type { MessageRow } from "../db";
import type { UnixMillis } from "../types";
import { BODY_RETENTION_MS } from "./constants";

export const INBOX_FETCH_MODES = [
	"unread",
	"recent",
	"pending_questions",
] as const;

export type InboxFetchMode = (typeof INBOX_FETCH_MODES)[number];

/** A question addressed to the fetching agent. */
export interface InboxQuestion {
	kind: "question";
	id: string;
	fromAgentId: string;
	categoryId: string;
	body: string;
	createdAt: UnixMillis;
	expiresAt: UnixMillis;
}

/** An answer to a question the fetching agent asked. */
export interface InboxAnswer {
	kind: "answer";
	id: string;
	/** The question this answers. */
	inReplyTo: string;
	fromAgentId: string;
	categoryId: string;
	body: string;
	createdAt: UnixMillis;
}

/**
 * A rejection of a question the fetching agent asked. It carries nothing
 * but the question it refers to, so that the asker cannot tell who rejected
 * the question or why (design 3.4). Not even the creation time is exposed.
 */
export interface InboxRejection {
	kind: "rejection";
	id: string;
	/** The question that was rejected. */
	inReplyTo: string;
}

export type InboxItem = InboxQuestion | InboxAnswer | InboxRejection;

/*
 * What an agent can still receive: undelivered questions that are waiting
 * for an answer and have not passed their deadline, and undelivered replies.
 * A question past its deadline is left out even before the maintenance run
 * marks it expired, because it can no longer be answered.
 *
 * Binds: ?1 = agent ID, ?2 = now.
 */
const DELIVERABLE = `to_agent_id = ?1
	AND status IN ('pending', 'sent')
	AND received_at IS NULL
	AND (expires_at IS NULL OR expires_at > ?2)`;

/*
 * Already-delivered, unanswered, unexpired questions addressed to the agent.
 *
 * Binds: ?1 = agent ID, ?2 = now.
 */
const RECOVERABLE_PENDING_QUESTIONS = `to_agent_id = ?1
	AND kind = 'question'
	AND status = 'pending'
	AND received_at IS NOT NULL
	AND body IS NOT NULL
	AND (expires_at IS NULL OR expires_at > ?2)`;

/*
 * Already-delivered messages still within their retention window: unanswered
 * unexpired questions, answers whose body remains within 24 hours of receipt,
 * and rejections within the same 24-hour window (rejections have no body).
 *
 * Binds: ?1 = agent ID, ?2 = now, ?3 = now - BODY_RETENTION_MS.
 */
const RECOVERABLE_RECENT = `to_agent_id = ?1
	AND received_at IS NOT NULL
	AND (
		(
			kind = 'question'
			AND status = 'pending'
			AND body IS NOT NULL
			AND (expires_at IS NULL OR expires_at > ?2)
		)
		OR (
			kind = 'answer'
			AND status = 'sent'
			AND body IS NOT NULL
			AND received_at > ?3
		)
		OR (
			kind = 'rejection'
			AND status = 'sent'
			AND received_at > ?3
		)
	)`;

function required<T>(value: T | null, column: string, id: string): T {
	if (value === null) {
		throw new Error(`Message ${id} has no ${column}`);
	}
	return value;
}

function itemFromRow(row: MessageRow): InboxItem {
	const { id } = row;
	switch (row.kind) {
		case "question":
			return {
				kind: "question",
				id,
				fromAgentId: required(row.from_agent_id, "from_agent_id", id),
				categoryId: required(row.category_id, "category_id", id),
				body: required(row.body, "body", id),
				createdAt: row.created_at,
				expiresAt: required(row.expires_at, "expires_at", id),
			};
		case "answer":
			return {
				kind: "answer",
				id,
				inReplyTo: required(row.in_reply_to, "in_reply_to", id),
				fromAgentId: required(row.from_agent_id, "from_agent_id", id),
				categoryId: required(row.category_id, "category_id", id),
				body: required(row.body, "body", id),
				createdAt: row.created_at,
			};
		case "rejection":
			return {
				kind: "rejection",
				id,
				inReplyTo: required(row.in_reply_to, "in_reply_to", id),
			};
		default:
			throw new Error(`Unknown value in messages.kind: ${row.kind}`);
	}
}

/**
 * Fetches messages for the agent, ordered oldest first.
 *
 * - `unread` (default): hands over every waiting message and marks it received
 *   in a single statement, so concurrent fetches never return the same message
 *   twice.
 * - `pending_questions` / `recent`: read-only recovery of already-delivered
 *   messages without changing `received_at`, so the 24-hour body-deletion
 *   timer is never extended.
 */
export async function fetchInbox(
	db: D1Database,
	agentId: string,
	now: UnixMillis,
	mode: InboxFetchMode = "unread",
): Promise<InboxItem[]> {
	switch (mode) {
		case "unread": {
			const { results } = await db
				.prepare(
					`UPDATE messages SET received_at = ?2 WHERE ${DELIVERABLE} RETURNING *`,
				)
				.bind(agentId, now)
				.all<MessageRow>();
			return results
				.sort(
					(a, b) =>
						a.created_at - b.created_at ||
						(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
				)
				.map(itemFromRow);
		}
		case "pending_questions": {
			const { results } = await db
				.prepare(
					`SELECT * FROM messages WHERE ${RECOVERABLE_PENDING_QUESTIONS} ORDER BY created_at ASC, id ASC`,
				)
				.bind(agentId, now)
				.all<MessageRow>();
			return results.map(itemFromRow);
		}
		case "recent": {
			const { results } = await db
				.prepare(
					`SELECT * FROM messages WHERE ${RECOVERABLE_RECENT} ORDER BY created_at ASC, id ASC`,
				)
				.bind(agentId, now, now - BODY_RETENTION_MS)
				.all<MessageRow>();
			return results.map(itemFromRow);
		}
	}
}

/** Counts the messages `fetchInbox` would hand over at `now`. */
export async function countUnread(
	db: D1Database,
	agentId: string,
	now: UnixMillis,
): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${DELIVERABLE}`)
		.bind(agentId, now)
		.first<{ n: number }>();
	return row?.n ?? 0;
}
