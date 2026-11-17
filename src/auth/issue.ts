import { insertToken } from "../db";
import type { TokenPurpose, UnixMillis } from "../types";
import { createToken, type NewToken } from "./token";

/**
 * Issues a token for an agent and purpose, and returns its plaintext once.
 *
 * It serves both the first issue and a reissue: any valid token of the same
 * agent and purpose is revoked in the same transaction, so the old token
 * stops working the moment the new one exists. Tokens of other purposes are
 * left alone.
 *
 * Rejects (foreign key) when the agent does not exist; nothing changes then.
 */
export async function issueToken(
	db: D1Database,
	input: { agentId: string; purpose: TokenPurpose; now: UnixMillis },
): Promise<NewToken> {
	const created = await createToken(input);
	await db.batch([
		db
			.prepare(
				`UPDATE tokens SET revoked_at = ?
				WHERE agent_id = ? AND purpose = ? AND revoked_at IS NULL`,
			)
			.bind(input.now, input.agentId, input.purpose),
		insertToken(db, created.record),
	]);
	return created;
}
