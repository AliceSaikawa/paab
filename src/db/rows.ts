import {
	AGENT_STATUSES,
	type Agent,
	type AllowRule,
	AUDIT_EVENT_TYPES,
	AUDIT_OUTCOMES,
	type AuditLogEntry,
	type Category,
	MESSAGE_KINDS,
	MESSAGE_STATUSES,
	type Message,
	REASON_CODES,
	TOKEN_PURPOSES,
	type Token,
} from "../types";

/*
 * Row shapes as stored in D1 (snake_case columns), and the conversion from a
 * row to the shared types. Use these with `SELECT *` or an equivalent column
 * list, for example:
 *
 *   const row = await db.prepare("SELECT * FROM agents WHERE id = ?")
 *     .bind(id).first<AgentRow>();
 *   const agent = row && agentFromRow(row);
 */

export interface AgentRow {
	id: string;
	owner_id: string;
	name: string;
	description: string;
	status: string;
	daily_question_limit: number;
	created_at: number;
}

export interface TokenRow {
	id: string;
	agent_id: string;
	token_hash: string;
	purpose: string;
	created_at: number;
	revoked_at: number | null;
}

export interface CategoryRow {
	id: string;
	name: string;
}

export interface AllowRuleRow {
	from_agent_id: string;
	to_agent_id: string;
	category_id: string;
	created_at: number;
}

export interface MessageRow {
	id: string;
	kind: string;
	from_agent_id: string | null;
	to_agent_id: string | null;
	category_id: string | null;
	body: string | null;
	in_reply_to: string | null;
	status: string;
	created_at: number;
	received_at: number | null;
	expires_at: number | null;
	body_deleted_at: number | null;
}

export interface AuditLogRow {
	id: number;
	occurred_at: number;
	event_type: string;
	from_agent_id: string | null;
	to_agent_id: string | null;
	category_id: string | null;
	outcome: string;
	reason_code: string | null;
	message_id: string | null;
	body: string | null;
}

/** Narrows a stored string to one of the known values, or throws. */
function oneOf<T extends string>(
	allowed: readonly T[],
	value: string,
	column: string,
): T {
	if (!(allowed as readonly string[]).includes(value)) {
		throw new Error(`Unknown value in ${column}: ${value}`);
	}
	return value as T;
}

export function agentFromRow(row: AgentRow): Agent {
	return {
		id: row.id,
		ownerId: row.owner_id,
		name: row.name,
		description: row.description,
		status: oneOf(AGENT_STATUSES, row.status, "agents.status"),
		dailyQuestionLimit: row.daily_question_limit,
		createdAt: row.created_at,
	};
}

export function tokenFromRow(row: TokenRow): Token {
	return {
		id: row.id,
		agentId: row.agent_id,
		tokenHash: row.token_hash,
		purpose: oneOf(TOKEN_PURPOSES, row.purpose, "tokens.purpose"),
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
	};
}

export function categoryFromRow(row: CategoryRow): Category {
	return { id: row.id, name: row.name };
}

export function allowRuleFromRow(row: AllowRuleRow): AllowRule {
	return {
		fromAgentId: row.from_agent_id,
		toAgentId: row.to_agent_id,
		categoryId: row.category_id,
		createdAt: row.created_at,
	};
}

export function messageFromRow(row: MessageRow): Message {
	return {
		id: row.id,
		kind: oneOf(MESSAGE_KINDS, row.kind, "messages.kind"),
		fromAgentId: row.from_agent_id,
		toAgentId: row.to_agent_id,
		categoryId: row.category_id,
		body: row.body,
		inReplyTo: row.in_reply_to,
		status: oneOf(MESSAGE_STATUSES, row.status, "messages.status"),
		createdAt: row.created_at,
		receivedAt: row.received_at,
		expiresAt: row.expires_at,
		bodyDeletedAt: row.body_deleted_at,
	};
}

export function auditLogEntryFromRow(row: AuditLogRow): AuditLogEntry {
	return {
		id: row.id,
		occurredAt: row.occurred_at,
		eventType: oneOf(AUDIT_EVENT_TYPES, row.event_type, "audit_log.event_type"),
		fromAgentId: row.from_agent_id,
		toAgentId: row.to_agent_id,
		categoryId: row.category_id,
		outcome: oneOf(AUDIT_OUTCOMES, row.outcome, "audit_log.outcome"),
		reasonCode:
			row.reason_code === null
				? null
				: oneOf(REASON_CODES, row.reason_code, "audit_log.reason_code"),
		messageId: row.message_id,
		body: row.body,
	};
}
