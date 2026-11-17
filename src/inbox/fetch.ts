import type { MessageRow } from "../db";
import type { UnixMillis } from "../types";

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
 * Hands over every message waiting for the agent and marks it received, in
 * a single statement, so that concurrent fetches never return the same
 * message twice. Items are ordered oldest first.
 */
export async function fetchInbox(
	db: D1Database,
	agentId: string,
	now: UnixMillis,
): Promise<InboxItem[]> {
	const { results } = await db
		.prepare(
			`UPDATE messages SET received_at = ?2 WHERE ${DELIVERABLE} RETURNING *`,
		)
		.bind(agentId, now)
		.all<MessageRow>();
	return results
		.sort(
			(a, b) =>
				a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		)
		.map(itemFromRow);
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
