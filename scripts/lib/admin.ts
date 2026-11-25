import type { UnixMillis } from "../../src/types";
import { CliError, type D1Client, sql } from "./sql";

// Operations on an agent that has already been seeded (#23). Suspend and
// resume flip agents.status, which the Worker checks on every request.
// revoke-token invalidates every valid token of the agent, whatever its
// purpose - the emergency answer to a leaked token. These are deliberately
// not recorded in audit_log: its event types describe message flow, and the
// change log that records who changed what arrives with the admin
// operations (#29).

interface AgentRow {
	id: string;
	status: string;
}

async function agentByName(db: D1Client, agentName: string): Promise<AgentRow> {
	const [agent] = await db.query(
		sql("SELECT id, status FROM agents WHERE name = ?", agentName),
	);
	if (agent === undefined) {
		throw new CliError(
			`エージェント「${agentName}」は登録されていません。D1 は変更していません。`,
		);
	}
	return { id: String(agent.id), status: String(agent.status) };
}

/**
 * Sets the agent's status atomically. Returns false when the agent already
 * had it, so the caller can say that nothing changed.
 */
export async function setAgentStatus(
	db: D1Client,
	agentName: string,
	status: "active" | "suspended",
): Promise<boolean> {
	const updated = await db.query(
		sql(
			"UPDATE agents SET status = ? WHERE name = ? AND status <> ? RETURNING id",
			status,
			agentName,
			status,
		),
	);
	if (updated.length > 0) {
		return true;
	}
	await agentByName(db, agentName);
	return false;
}

/**
 * Revokes every valid token of the agent atomically across all purposes.
 * Returns how many tokens were revoked.
 */
export async function revokeAgentTokens(
	db: D1Client,
	agentName: string,
	now: UnixMillis,
): Promise<number> {
	const agent = await agentByName(db, agentName);
	const rows = await db.query(
		sql(
			"UPDATE tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL RETURNING id",
			now,
			agent.id,
		),
	);
	return rows.length;
}
