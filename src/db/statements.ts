import type {
	Agent,
	AllowRule,
	Category,
	Message,
	NewAuditLogEntry,
	Token,
} from "../types";

/*
 * INSERT statements for each table, with the values bound. They are returned
 * unexecuted so that callers can run them alone (`.run()`) or together in
 * one `db.batch([...])`, which D1 executes as a transaction.
 */

export function insertAgent(db: D1Database, agent: Agent): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO agents
				(id, owner_id, name, description, status, daily_question_limit, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			agent.id,
			agent.ownerId,
			agent.name,
			agent.description,
			agent.status,
			agent.dailyQuestionLimit,
			agent.createdAt,
		);
}

export function insertToken(db: D1Database, token: Token): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO tokens
				(id, agent_id, token_hash, purpose, created_at, revoked_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			token.id,
			token.agentId,
			token.tokenHash,
			token.purpose,
			token.createdAt,
			token.revokedAt,
		);
}

export function insertCategory(
	db: D1Database,
	category: Category,
): D1PreparedStatement {
	return db
		.prepare("INSERT INTO categories (id, name) VALUES (?, ?)")
		.bind(category.id, category.name);
}

export function insertAllowRule(
	db: D1Database,
	rule: AllowRule,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO allow_rules
				(from_agent_id, to_agent_id, category_id, created_at)
			VALUES (?, ?, ?, ?)`,
		)
		.bind(rule.fromAgentId, rule.toAgentId, rule.categoryId, rule.createdAt);
}

export function insertMessage(
	db: D1Database,
	message: Message,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO messages
				(id, kind, from_agent_id, to_agent_id, category_id, body, in_reply_to,
				status, created_at, received_at, expires_at, body_deleted_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			message.id,
			message.kind,
			message.fromAgentId,
			message.toAgentId,
			message.categoryId,
			message.body,
			message.inReplyTo,
			message.status,
			message.createdAt,
			message.receivedAt,
			message.expiresAt,
			message.bodyDeletedAt,
		);
}

/** The database assigns the ID; read it from `meta.last_row_id`. */
export function insertAuditLogEntry(
	db: D1Database,
	entry: NewAuditLogEntry,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO audit_log
				(occurred_at, event_type, from_agent_id, to_agent_id, category_id,
				outcome, reason_code, message_id, body)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
		);
}
