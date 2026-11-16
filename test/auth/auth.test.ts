import { beforeEach, describe, expect, it } from "vitest";
import {
	auditReasonCode,
	authenticate,
	createToken,
	generateToken,
	hashToken,
	issueToken,
	isWellFormedToken,
	parseBearerToken,
	TOKEN_PREFIX,
} from "../../src/auth";
import { REASON_CODES } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { seedAgent, T0 } from "../helpers/fixtures";

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
});

function bearer(token: string): string {
	return `Bearer ${token}`;
}

describe("generateToken", () => {
	it("returns the prefix and 43 base64url characters", () => {
		const token = generateToken();
		expect(token).toMatch(/^paab_[A-Za-z0-9_-]{43}$/);
		expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
		expect(isWellFormedToken(token)).toBe(true);
	});

	it("returns a different token every time", () => {
		const tokens = new Set(Array.from({ length: 100 }, generateToken));
		expect(tokens.size).toBe(100);
	});
});

describe("hashToken", () => {
	it("returns the SHA-256 of the token in lowercase hex", async () => {
		// Known answer: SHA-256("abc").
		expect(await hashToken("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("is deterministic and differs between tokens", async () => {
		const token = generateToken();
		expect(await hashToken(token)).toBe(await hashToken(token));
		expect(await hashToken(token)).not.toBe(await hashToken(generateToken()));
	});
});

describe("parseBearerToken", () => {
	it("extracts the token from a Bearer header", () => {
		expect(parseBearerToken("Bearer abc")).toBe("abc");
		expect(parseBearerToken("bearer   abc ")).toBe("abc");
	});

	it("returns null for anything else", () => {
		for (const header of [null, "", "Bearer", "Bearer ", "Basic abc", "abc"]) {
			expect(parseBearerToken(header)).toBeNull();
		}
		expect(parseBearerToken("Bearer a b")).toBeNull();
	});
});

describe("authenticate", () => {
	it("returns the agent a valid token belongs to", async () => {
		const alice = await seedAgent(db);
		const bob = await seedAgent(db);
		const forAlice = await issueToken(db, {
			agentId: alice.id,
			purpose: "participant",
			now: T0,
		});
		const forBob = await issueToken(db, {
			agentId: bob.id,
			purpose: "participant",
			now: T0,
		});

		expect(
			await authenticate(db, bearer(forAlice.token), "participant"),
		).toEqual({
			ok: true,
			agent: alice,
			suspended: false,
			tokenId: forAlice.record.id,
		});
		expect(await authenticate(db, bearer(forBob.token), "participant")).toEqual(
			{ ok: true, agent: bob, suspended: false, tokenId: forBob.record.id },
		);
	});

	it("fails without a Bearer header", async () => {
		const agent = await seedAgent(db);
		const { token } = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});

		for (const header of [null, "", `Basic ${token}`, token]) {
			expect(await authenticate(db, header, "participant")).toEqual({
				ok: false,
				reason: "token_missing",
				agentId: null,
			});
		}
	});

	it("fails for a token that was never issued", async () => {
		const agent = await seedAgent(db);
		await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});

		for (const token of [generateToken(), "not-a-token", "paab_short"]) {
			expect(await authenticate(db, bearer(token), "participant")).toEqual({
				ok: false,
				reason: "token_unknown",
				agentId: null,
			});
		}
	});

	it("fails for a token that differs in one character", async () => {
		const agent = await seedAgent(db);
		const { token } = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});
		const last = token.at(-1) === "A" ? "B" : "A";
		const altered = token.slice(0, -1) + last;

		const result = await authenticate(db, bearer(altered), "participant");
		expect(result).toMatchObject({ ok: false, reason: "token_unknown" });
	});

	it("fails for a revoked token", async () => {
		const agent = await seedAgent(db);
		const { token, record } = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});
		await db
			.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
			.bind(T0 + 1, record.id)
			.run();

		expect(await authenticate(db, bearer(token), "participant")).toEqual({
			ok: false,
			reason: "token_revoked",
			agentId: agent.id,
		});
	});

	it("fails once the agent is deleted", async () => {
		const agent = await seedAgent(db);
		const { token } = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});
		await db.prepare("DELETE FROM agents WHERE id = ?").bind(agent.id).run();

		expect(await authenticate(db, bearer(token), "participant")).toEqual({
			ok: false,
			reason: "token_unknown",
			agentId: null,
		});
	});

	it("resolves a suspended agent and marks it as suspended", async () => {
		const agent = await seedAgent(db, { status: "suspended" });
		const { token, record } = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});

		expect(await authenticate(db, bearer(token), "participant")).toEqual({
			ok: true,
			agent,
			suspended: true,
			tokenId: record.id,
		});
	});

	it("accepts a token only for its own purpose", async () => {
		const agent = await seedAgent(db);
		const participant = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});
		const admin = await issueToken(db, {
			agentId: agent.id,
			purpose: "admin",
			now: T0,
		});
		const unread = await issueToken(db, {
			agentId: agent.id,
			purpose: "unread_count",
			now: T0,
		});

		for (const { token } of [admin, unread]) {
			expect(await authenticate(db, bearer(token), "participant")).toEqual({
				ok: false,
				reason: "token_wrong_purpose",
				agentId: agent.id,
			});
		}
		expect(
			await authenticate(db, bearer(participant.token), "unread_count"),
		).toMatchObject({ ok: false, reason: "token_wrong_purpose" });
		expect(
			await authenticate(db, bearer(unread.token), "unread_count"),
		).toMatchObject({ ok: true, agent });
		expect(await authenticate(db, bearer(admin.token), "admin")).toMatchObject({
			ok: true,
			agent,
		});
	});
});

describe("auditReasonCode", () => {
	it("maps every failure to a shared reason code", () => {
		for (const reason of [
			"token_missing",
			"token_unknown",
			"token_revoked",
			"token_wrong_purpose",
		] as const) {
			expect(REASON_CODES).toContain(auditReasonCode(reason));
		}
		expect(auditReasonCode("token_wrong_purpose")).toBe("token_unknown");
		expect(auditReasonCode("token_revoked")).toBe("token_revoked");
	});
});

describe("issueToken", () => {
	it("invalidates the old token when reissuing", async () => {
		const agent = await seedAgent(db);
		const old = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});
		const renewed = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0 + 1000,
		});

		expect(renewed.token).not.toBe(old.token);
		expect(await authenticate(db, bearer(old.token), "participant")).toEqual({
			ok: false,
			reason: "token_revoked",
			agentId: agent.id,
		});
		expect(
			await authenticate(db, bearer(renewed.token), "participant"),
		).toMatchObject({ ok: true, agent, tokenId: renewed.record.id });

		const rows = await db
			.prepare(
				"SELECT id, revoked_at FROM tokens WHERE agent_id = ? ORDER BY created_at",
			)
			.bind(agent.id)
			.all<{ id: string; revoked_at: number | null }>();
		expect(rows.results).toEqual([
			{ id: old.record.id, revoked_at: T0 + 1000 },
			{ id: renewed.record.id, revoked_at: null },
		]);
	});

	it("leaves other purposes and other agents alone when reissuing", async () => {
		const alice = await seedAgent(db);
		const bob = await seedAgent(db);
		const unread = await issueToken(db, {
			agentId: alice.id,
			purpose: "unread_count",
			now: T0,
		});
		const forBob = await issueToken(db, {
			agentId: bob.id,
			purpose: "participant",
			now: T0,
		});
		await issueToken(db, {
			agentId: alice.id,
			purpose: "participant",
			now: T0,
		});
		await issueToken(db, {
			agentId: alice.id,
			purpose: "participant",
			now: T0 + 1,
		});

		expect(
			await authenticate(db, bearer(unread.token), "unread_count"),
		).toMatchObject({ ok: true, agent: alice });
		expect(
			await authenticate(db, bearer(forBob.token), "participant"),
		).toMatchObject({ ok: true, agent: bob });
	});

	it("stores the hash and never the plaintext", async () => {
		const agent = await seedAgent(db);
		const first = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});
		const second = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0 + 1,
		});

		const rows = await db.prepare("SELECT * FROM tokens").all();
		expect(rows.results).toHaveLength(2);
		const stored = JSON.stringify(rows.results);
		for (const { token, record } of [first, second]) {
			expect(stored).not.toContain(token);
			expect(stored).not.toContain(token.slice(TOKEN_PREFIX.length));
			expect(record.tokenHash).toBe(await hashToken(token));
			expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/);
			expect(stored).toContain(record.tokenHash);
			expect(JSON.stringify(record)).not.toContain(token);
		}
	});

	it("rejects an agent that does not exist and changes nothing", async () => {
		await expect(
			issueToken(db, { agentId: "ghost", purpose: "participant", now: T0 }),
		).rejects.toThrow(/FOREIGN KEY/);
		const count = await db
			.prepare("SELECT COUNT(*) AS n FROM tokens")
			.first<{ n: number }>();
		expect(count?.n).toBe(0);
	});
});

describe("createToken", () => {
	it("builds a valid row without touching the database", async () => {
		const { token, record } = await createToken({
			agentId: "agent-1",
			purpose: "unread_count",
			now: T0,
		});

		expect(isWellFormedToken(token)).toBe(true);
		expect(record).toMatchObject({
			agentId: "agent-1",
			tokenHash: await hashToken(token),
			purpose: "unread_count",
			createdAt: T0,
			revokedAt: null,
		});
		const count = await db
			.prepare("SELECT COUNT(*) AS n FROM tokens")
			.first<{ n: number }>();
		expect(count?.n).toBe(0);
	});
});
