import { type AgentRow, agentFromRow } from "../db";
import type { Agent, ReasonCode, TokenPurpose } from "../types";
import { hashToken, isWellFormedToken } from "./token";

/**
 * Why authentication failed. For the audit log only: every failure must look
 * the same to the client (a bare 401).
 * - `token_missing`: no `Authorization: Bearer ...` header.
 * - `token_unknown`: no such token, or one that is not even token-shaped.
 * - `token_revoked`: the token was revoked or replaced by a reissue.
 * - `token_wrong_purpose`: a valid token of another purpose, for example an
 *   unread count token presented to the MCP endpoint.
 */
export type AuthFailureReason =
	| "token_missing"
	| "token_unknown"
	| "token_revoked"
	| "token_wrong_purpose";

export type AuthResult =
	| {
			ok: true;
			agent: Agent;
			/**
			 * True when the agent is suspended. The token still resolves so that
			 * the caller knows who is asking, but the caller must refuse to serve
			 * a suspended agent.
			 */
			suspended: boolean;
			tokenId: string;
	  }
	| {
			ok: false;
			reason: AuthFailureReason;
			/** The owner of the token, when the token itself was recognized. */
			agentId: string | null;
	  };

/**
 * Maps a failure to a reason code the audit log accepts. The shared reason
 * codes have no value for a token of the wrong purpose, so it is recorded as
 * unknown.
 */
export function auditReasonCode(reason: AuthFailureReason): ReasonCode {
	return reason === "token_wrong_purpose" ? "token_unknown" : reason;
}

/**
 * Extracts the token from the value of an `Authorization` header. Returns
 * null unless the value is `Bearer <token>` (scheme in any letter case).
 */
export function parseBearerToken(header: string | null): string | null {
	if (header === null) {
		return null;
	}
	const match = /^Bearer +(\S+)$/i.exec(header.trim());
	return match?.[1] ?? null;
}

/** Compares two hashes without leaking where they first differ. */
function hashesEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	// The length of a hash is not secret, and timingSafeEqual throws on a
	// length mismatch.
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	return crypto.subtle.timingSafeEqual(left, right);
}

interface TokenWithAgentRow extends AgentRow {
	token_id: string;
	token_hash: string;
	token_purpose: string;
	token_revoked_at: number | null;
}

/**
 * Resolves the agent behind an `Authorization` header.
 *
 * `purpose` is the single kind of token the calling endpoint accepts: the MCP
 * endpoint passes `"participant"`, the unread count endpoint
 * `"unread_count"`. A token of any other purpose fails.
 *
 * A suspended agent resolves with `suspended: true`; see `AuthResult`.
 *
 *   const auth = await authenticate(
 *     db, request.headers.get("Authorization"), "participant");
 *   if (!auth.ok) return new Response(null, { status: 401 });
 *
 * The token plaintext never appears in the result or in a thrown error.
 */
export async function authenticate(
	db: D1Database,
	authorizationHeader: string | null,
	purpose: TokenPurpose,
): Promise<AuthResult> {
	const token = parseBearerToken(authorizationHeader);
	if (token === null) {
		return { ok: false, reason: "token_missing", agentId: null };
	}
	if (!isWellFormedToken(token)) {
		return { ok: false, reason: "token_unknown", agentId: null };
	}

	const tokenHash = await hashToken(token);
	// The join drops a token whose agent no longer exists.
	const row = await db
		.prepare(
			`SELECT
				t.id AS token_id,
				t.token_hash AS token_hash,
				t.purpose AS token_purpose,
				t.revoked_at AS token_revoked_at,
				a.id, a.owner_id, a.name, a.description, a.status,
				a.daily_question_limit, a.created_at
			FROM tokens t
			JOIN agents a ON a.id = t.agent_id
			WHERE t.token_hash = ?`,
		)
		.bind(tokenHash)
		.first<TokenWithAgentRow>();

	// The index lookup above is not constant-time, so confirm the match with a
	// comparison that is, rather than trusting the lookup alone.
	if (row === null || !hashesEqual(row.token_hash, tokenHash)) {
		return { ok: false, reason: "token_unknown", agentId: null };
	}
	if (row.token_revoked_at !== null) {
		return { ok: false, reason: "token_revoked", agentId: row.id };
	}
	if (row.token_purpose !== purpose) {
		return { ok: false, reason: "token_wrong_purpose", agentId: row.id };
	}

	const agent = agentFromRow(row);
	return {
		ok: true,
		agent,
		suspended: agent.status === "suspended",
		tokenId: row.token_id,
	};
}
