import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	issueAgentToken,
	queryChangeLog,
	revokeAgentTokens,
} from "../../src/admin";
import { authenticate, hashToken } from "../../src/auth";
import { newId, type TokenRow } from "../../src/db";
import type { Agent, TokenPurpose } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { HOUR_MS, seedAgent, T0 } from "../helpers/fixtures";

const OWNER: ChangeActor = { actorType: "owner", actorId: "me" };

let db: D1Database;
let muse: Agent;

beforeEach(async () => {
	db = await createTestDb();
	muse = await seedAgent(db, { name: "muse" });
});

async function assertNoSecretLeak(token: string) {
	const tokenHash = await hashToken(token);
	const bodyOnly = token.slice("paab_".length);
	const [tokenRows, changeRows] = await db.batch([
		db.prepare("SELECT * FROM tokens"),
		db.prepare("SELECT * FROM change_log"),
	]);
	const tokensJson = JSON.stringify(tokenRows.results);
	const changesJson = JSON.stringify(changeRows.results);
	expect(tokensJson).not.toContain(token);
	expect(tokensJson).not.toContain(bodyOnly);
	expect(changesJson).not.toContain(token);
	expect(changesJson).not.toContain(bodyOnly);
	expect(changesJson).not.toContain(tokenHash);
}

describe("issueAgentToken", () => {
	it("issues tokens per purpose, authenticates, and logs metadata without secrets", async () => {
		const purposes: TokenPurpose[] = ["participant", "admin", "unread_count"];
		for (const [idx, purpose] of purposes.entries()) {
			const res = await issueAgentToken(db, {
				agentId: muse.id,
				purpose,
				actor: OWNER,
				now: T0 + idx,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) continue;

			expect(res.data.revokedPrevious).toBe(false);
			expect(
				await authenticate(db, `Bearer ${res.data.token}`, purpose),
			).toMatchObject({ ok: true, agent: { id: muse.id } });

			await assertNoSecretLeak(res.data.token);
		}

		const logs = await queryChangeLog(db);
		expect(logs).toHaveLength(3);
		expect(logs[0]).toMatchObject({
			actorType: "owner",
			actorId: "me",
			action: "token_issued",
			targetType: "token",
			beforeJson: null,
		});
		expect(JSON.parse(logs[0]?.afterJson ?? "null")).toEqual({
			id: logs[0]?.targetId,
			purpose: "unread_count",
			agentId: muse.id,
		});
	});

	it("revokes the previous token of the same purpose on reissue and records beforeJson", async () => {
		const first = await issueAgentToken(db, {
			agentId: muse.id,
			purpose: "participant",
			actor: OWNER,
			now: T0,
		});
		const unread = await issueAgentToken(db, {
			agentId: muse.id,
			purpose: "unread_count",
			actor: OWNER,
			now: T0 + 1,
		});
		expect(first.ok && unread.ok).toBe(true);
		if (!first.ok || !unread.ok) return;

		const second = await issueAgentToken(db, {
			agentId: muse.id,
			purpose: "participant",
			actor: OWNER,
			now: T0 + HOUR_MS,
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.revokedPrevious).toBe(true);

		expect(
			await authenticate(db, `Bearer ${first.data.token}`, "participant"),
		).toMatchObject({ ok: false, reason: "token_revoked" });
		expect(
			await authenticate(db, `Bearer ${second.data.token}`, "participant"),
		).toMatchObject({ ok: true, agent: { id: muse.id } });
		expect(
			await authenticate(db, `Bearer ${unread.data.token}`, "unread_count"),
		).toMatchObject({ ok: true, agent: { id: muse.id } });

		await assertNoSecretLeak(first.data.token);
		await assertNoSecretLeak(second.data.token);

		const [latest] = await queryChangeLog(db, { limit: 1 });
		expect(JSON.parse(latest?.beforeJson ?? "null")).toEqual({
			id: first.data.tokenId,
			purpose: "participant",
			agentId: muse.id,
		});
		expect(JSON.parse(latest?.afterJson ?? "null")).toEqual({
			id: second.data.tokenId,
			purpose: "participant",
			agentId: muse.id,
		});
	});

	it("rejects missing agent and invalid purpose without writing anything", async () => {
		expect(
			await issueAgentToken(db, {
				agentId: newId(),
				purpose: "participant",
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_found" });

		expect(
			await issueAgentToken(db, {
				agentId: muse.id,
				purpose: "bogus" as TokenPurpose,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });

		const tokens = await db.prepare("SELECT * FROM tokens").all<TokenRow>();
		expect(tokens.results).toHaveLength(0);
		expect(await queryChangeLog(db)).toHaveLength(0);
	});
});

describe("revokeAgentTokens", () => {
	it("revokes only the requested purpose when specified", async () => {
		const part = await issueAgentToken(db, {
			agentId: muse.id,
			purpose: "participant",
			actor: OWNER,
			now: T0,
		});
		const adminTok = await issueAgentToken(db, {
			agentId: muse.id,
			purpose: "admin",
			actor: OWNER,
			now: T0 + 1,
		});
		if (!part.ok || !adminTok.ok) return;

		const rev = await revokeAgentTokens(db, {
			agentId: muse.id,
			purpose: "participant",
			actor: OWNER,
			now: T0 + 2,
		});
		expect(rev.ok).toBe(true);
		if (!rev.ok) return;
		expect(rev.data.revokedCount).toBe(1);
		expect(rev.changeId).toBeTypeOf("number");

		expect(
			await authenticate(db, `Bearer ${part.data.token}`, "participant"),
		).toMatchObject({ ok: false, reason: "token_revoked" });
		expect(
			await authenticate(db, `Bearer ${adminTok.data.token}`, "admin"),
		).toMatchObject({ ok: true });

		const [latest] = await queryChangeLog(db, { limit: 1 });
		expect(latest?.action).toBe("token_revoked");
		expect(latest?.targetId).toBe(part.data.tokenId);
		expect(latest?.afterJson).toBeNull();
		expect(JSON.parse(latest?.beforeJson ?? "null")).toEqual({
			agentId: muse.id,
			tokens: [
				{ id: part.data.tokenId, purpose: "participant", agentId: muse.id },
			],
		});
	});

	it("revokes all active tokens when purpose is omitted", async () => {
		const part = await issueAgentToken(db, {
			agentId: muse.id,
			purpose: "participant",
			actor: OWNER,
			now: T0,
		});
		const unread = await issueAgentToken(db, {
			agentId: muse.id,
			purpose: "unread_count",
			actor: OWNER,
			now: T0 + 1,
		});
		if (!part.ok || !unread.ok) return;

		const rev = await revokeAgentTokens(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 2,
		});
		expect(rev.ok).toBe(true);
		if (!rev.ok) return;
		expect(rev.data.revokedCount).toBe(2);

		expect(
			await authenticate(db, `Bearer ${part.data.token}`, "participant"),
		).toMatchObject({ ok: false, reason: "token_revoked" });
		expect(
			await authenticate(db, `Bearer ${unread.data.token}`, "unread_count"),
		).toMatchObject({ ok: false, reason: "token_revoked" });

		await assertNoSecretLeak(part.data.token);
		await assertNoSecretLeak(unread.data.token);
	});

	it("returns revokedCount: 0 with changeId: null and writes no change_log when no tokens are active", async () => {
		const rev = await revokeAgentTokens(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0,
		});
		expect(rev).toEqual({
			ok: true,
			data: { revokedCount: 0 },
			changeId: null,
		});
		expect(await queryChangeLog(db)).toHaveLength(0);
	});

	it("rejects missing agent without writing anything", async () => {
		expect(
			await revokeAgentTokens(db, {
				agentId: newId(),
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_found" });
		expect(await queryChangeLog(db)).toHaveLength(0);
	});
});
