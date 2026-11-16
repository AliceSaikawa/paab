import { newId } from "../db";
import type { Token, TokenPurpose, UnixMillis } from "../types";

/*
 * Token format: `paab_` followed by 32 random bytes in unpadded base64url,
 * 48 characters in total, for example
 *
 *   paab_0Zk3...43 characters of [A-Za-z0-9_-]...
 *
 * The prefix only makes a leaked token recognizable (to people and to secret
 * scanners). It carries no meaning: the agent and the purpose of a token come
 * from the database alone.
 *
 * Nothing in this file needs a database or Workers-only APIs, so the
 * management commands can use it from Node as well.
 */

export const TOKEN_PREFIX = "paab_";

const TOKEN_RANDOM_BYTES = 32;
const TOKEN_PATTERN = /^paab_[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

/** Generates a new token plaintext with 256 bits of randomness. */
export function generateToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_RANDOM_BYTES));
	return TOKEN_PREFIX + toBase64Url(bytes);
}

/** Whether `value` has the shape of a token `generateToken()` returns. */
export function isWellFormedToken(value: string): boolean {
	return TOKEN_PATTERN.test(value);
}

/**
 * Hashes a token plaintext for storage and lookup: SHA-256 as 64 lowercase
 * hex characters.
 *
 * A fast, unsalted hash is enough here because a token is 256 random bits
 * rather than a password, so nobody can guess candidates to hash. It also has
 * to be deterministic, because the hash is the lookup key.
 */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	let hex = "";
	for (const byte of new Uint8Array(digest)) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

export interface NewToken {
	/** The plaintext. Show it to the user once and never store or log it. */
	token: string;
	/** The row to store. It holds the hash only. */
	record: Token;
}

/**
 * Generates a token and the row that represents it, without touching the
 * database. Use `issueToken()` to store it through a D1 binding; callers
 * without one must revoke the valid token of the same agent and purpose
 * before inserting `record`, in one transaction.
 */
export async function createToken(input: {
	agentId: string;
	purpose: TokenPurpose;
	now: UnixMillis;
}): Promise<NewToken> {
	const token = generateToken();
	return {
		token,
		record: {
			id: newId(),
			agentId: input.agentId,
			tokenHash: await hashToken(token),
			purpose: input.purpose,
			createdAt: input.now,
			revokedAt: null,
		},
	};
}
