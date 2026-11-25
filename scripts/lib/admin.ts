import { type AgentRow, agentFromRow, oneOf } from "../../src/db/rows";
import {
	type Agent,
	type NewChangeLogEntry,
	TOKEN_PURPOSES,
	type UnixMillis,
} from "../../src/types";
import { CliError, type D1Client, sql } from "./sql";

// Operations on an agent that has already been seeded (#23). Suspend and
// resume flip agents.status, which the Worker checks on every request.
// revoke-token invalidates every valid token of the agent, whatever its
// purpose - the emergency answer to a leaked token. These are deliberately
// not recorded in audit_log (whose event types describe message flow); they
// record in change_log (#29) instead.

export function insertChangeLogSql(entry: NewChangeLogEntry): string {
	const params: (string | number)[] = [
		entry.occurredAt,
		entry.actorType,
		entry.actorId,
	];
	const nullable = (value: string | number | null): string => {
		if (value === null) {
			return "NULL";
		}
		params.push(value);
		return "?";
	};
	const approver = nullable(entry.approverId);
	params.push(entry.action, entry.targetType, entry.targetId);
	const beforeJson = nullable(entry.beforeJson);
	const afterJson = nullable(entry.afterJson);
	const revertedAt = nullable(entry.revertedAt);
	return sql(
		`INSERT INTO change_log
			(occurred_at, actor_type, actor_id, approver_id, action,
			target_type, target_id, before_json, after_json, reverted_at)
		VALUES (?, ?, ?, ${approver}, ?, ?, ?, ${beforeJson}, ${afterJson}, ${revertedAt})`,
		...params,
	);
}

async function agentByName(db: D1Client, agentName: string): Promise<Agent> {
	const [row] = await db.query(
		sql(
			`SELECT id, owner_id, name, description, status, daily_question_limit, created_at
			FROM agents WHERE name = ?`,
			agentName,
		),
	);
	if (row === undefined) {
		throw new CliError(
			`エージェント「${agentName}」は登録されていません。D1 は変更していません。`,
		);
	}
	return agentFromRow(row as unknown as AgentRow);
}

/**
 * Sets the agent's status. Returns false when the agent already had it, so
 * the caller can say that nothing changed.
 */
export async function setAgentStatus(
	db: D1Client,
	agentName: string,
	status: "active" | "suspended",
	now: UnixMillis = Date.now(),
): Promise<boolean> {
	const agent = await agentByName(db, agentName);
	if (agent.status === status) {
		return false;
	}
	const updated: Agent = { ...agent, status };
	await db.execute([
		sql("UPDATE agents SET status = ? WHERE id = ?", status, agent.id),
		insertChangeLogSql({
			occurredAt: now,
			actorType: "owner",
			actorId: "cli",
			approverId: null,
			action: status === "suspended" ? "agent_suspended" : "agent_resumed",
			targetType: "agent",
			targetId: agent.id,
			beforeJson: JSON.stringify(agent),
			afterJson: JSON.stringify(updated),
			revertedAt: null,
		}),
	]);
	return true;
}

/**
 * Revokes every valid token of the agent, of every purpose. Returns how
 * many tokens were revoked.
 */
export async function revokeAgentTokens(
	db: D1Client,
	agentName: string,
	now: UnixMillis,
): Promise<number> {
	const agent = await agentByName(db, agentName);
	const rows = await db.query(
		sql(
			`SELECT id, agent_id, purpose FROM tokens
			WHERE agent_id = ? AND revoked_at IS NULL
			ORDER BY created_at ASC, id ASC`,
			agent.id,
		),
	);
	if (rows.length === 0) {
		return 0;
	}
	const tokens = rows.map((row) => ({
		id: String(row.id),
		purpose: oneOf(TOKEN_PURPOSES, String(row.purpose), "tokens.purpose"),
		agentId: String(row.agent_id),
	}));
	const targetId = tokens.length === 1 ? (tokens[0]?.id ?? agent.id) : agent.id;
	await db.execute([
		sql(
			"UPDATE tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL",
			now,
			agent.id,
		),
		insertChangeLogSql({
			occurredAt: now,
			actorType: "owner",
			actorId: "cli",
			approverId: null,
			action: "token_revoked",
			targetType: "token",
			targetId,
			beforeJson: JSON.stringify({ agentId: agent.id, tokens }),
			afterJson: null,
			revertedAt: null,
		}),
	]);
	return tokens.length;
}
