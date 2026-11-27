import type {
	Agent,
	AgentWebhook,
	AllowRule,
	Category,
	Message,
	NewAuditLogEntry,
	NewChangeLogEntry,
	PendingDescription,
	Proposal,
	Token,
	WebhookDelivery,
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
				status, created_at, received_at, expires_at, body_deleted_at, available_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			message.availableAt,
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

/** The database assigns the ID; read it from `meta.last_row_id`. */
export function insertChangeLogEntry(
	db: D1Database,
	entry: NewChangeLogEntry,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO change_log
				(occurred_at, actor_type, actor_id, approver_id, action,
				target_type, target_id, before_json, after_json, reverted_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			entry.occurredAt,
			entry.actorType,
			entry.actorId,
			entry.approverId,
			entry.action,
			entry.targetType,
			entry.targetId,
			entry.beforeJson,
			entry.afterJson,
			entry.revertedAt,
		);
}

export function insertProposal(
	db: D1Database,
	proposal: Proposal,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO proposals
				(id, kind, proposer_agent_id, payload_json, reason, status,
				created_at, expires_at, resolved_at, resolved_by, change_log_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			proposal.id,
			proposal.kind,
			proposal.proposerAgentId,
			JSON.stringify(proposal.payload),
			proposal.reason,
			proposal.status,
			proposal.createdAt,
			proposal.expiresAt,
			proposal.resolvedAt,
			proposal.resolvedBy,
			proposal.changeLogId,
		);
}

export function upsertPendingDescription(
	db: D1Database,
	pending: PendingDescription,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO pending_descriptions
				(agent_id, submission_id, description, submitted_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT (agent_id) DO UPDATE SET
				submission_id = excluded.submission_id,
				description = excluded.description,
				submitted_at = excluded.submitted_at`,
		)
		.bind(
			pending.agentId,
			pending.submissionId,
			pending.description,
			pending.submittedAt,
		);
}

export function upsertAgentWebhook(
	db: D1Database,
	webhook: AgentWebhook,
): D1PreparedStatement {
	const headerName =
		webhook.authMode === "custom_header" ? webhook.headerName : null;
	return db
		.prepare(
			`INSERT INTO agent_webhooks
				(agent_id, url, auth_mode, header_name, secret, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (agent_id) DO UPDATE SET
				url = excluded.url,
				auth_mode = excluded.auth_mode,
				header_name = excluded.header_name,
				secret = excluded.secret,
				updated_at = excluded.updated_at`,
		)
		.bind(
			webhook.agentId,
			webhook.url,
			webhook.authMode,
			headerName,
			webhook.secret,
			webhook.createdAt,
			webhook.updatedAt,
		);
}

export function insertWebhookDelivery(
	db: D1Database,
	delivery: WebhookDelivery,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO webhook_deliveries
				(id, agent_id, status, attempts, next_attempt_at, leased_until,
				last_error, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			delivery.id,
			delivery.agentId,
			delivery.status,
			delivery.attempts,
			delivery.nextAttemptAt,
			delivery.leasedUntil,
			delivery.lastError,
			delivery.createdAt,
			delivery.updatedAt,
		);
}
