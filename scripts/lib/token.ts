import { createToken } from "../../src/auth/token";
import type { UnixMillis } from "../../src/types";
import { CliError, type D1Client, sql } from "./sql";

export interface IssuedToken {
	/** The plaintext. Print it once and never store or log it. */
	token: string;
	/** Whether a valid token existed and has been revoked by this issue. */
	revokedPrevious: boolean;
}

/**
 * Issues a participant token for the agent with this name. Any valid
 * participant token of the agent is revoked in the same transaction, so the
 * old one stops working the moment the new one exists. Only the hash reaches
 * the database.
 */
export async function issueParticipantToken(
	db: D1Client,
	agentName: string,
	now: UnixMillis,
): Promise<IssuedToken> {
	const [agent] = await db.query(
		sql(
			`SELECT a.id,
				(SELECT count(*) FROM tokens t
					WHERE t.agent_id = a.id AND t.purpose = 'participant'
					AND t.revoked_at IS NULL) AS active_tokens
			FROM agents a WHERE a.name = ?`,
			agentName,
		),
	);
	if (agent === undefined) {
		throw new CliError(
			`エージェント「${agentName}」は登録されていません。トークンは発行していません。`,
		);
	}

	const { token, record } = await createToken({
		agentId: String(agent.id),
		purpose: "participant",
		now,
	});
	await db.execute([
		sql(
			`UPDATE tokens SET revoked_at = ?
			WHERE agent_id = ? AND purpose = 'participant' AND revoked_at IS NULL`,
			now,
			record.agentId,
		),
		sql(
			`INSERT INTO tokens (id, agent_id, token_hash, purpose, created_at, revoked_at)
			VALUES (?, ?, ?, 'participant', ?, NULL)`,
			record.id,
			record.agentId,
			record.tokenHash,
			record.createdAt,
		),
	]);
	return { token, revokedPrevious: agent.active_tokens !== 0 };
}
