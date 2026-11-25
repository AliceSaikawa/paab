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
 * Sets the agent's status. Returns false when the agent already had it, so
 * the caller can say that nothing changed.
 */
export async function setAgentStatus(
	db: D1Client,
	agentName: string,
	status: "active" | "suspended",
): Promise<boolean> {
	const agent = await agentByName(db, agentName);
	if (agent.status === status) {
		return false;
	}
	await db.execute([
		sql("UPDATE agents SET status = ? WHERE id = ?", status, agent.id),
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
	const [row] = await db.query(
		sql(
			"SELECT count(*) AS n FROM tokens WHERE agent_id = ? AND revoked_at IS NULL",
			agent.id,
		),
	);
	const count = Number(row?.n ?? 0);
	if (count === 0) {
		return 0;
	}
	await db.execute([
		sql(
			"UPDATE tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL",
			now,
			agent.id,
		),
	]);
	return count;
}
