import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	deleteAgent,
	issueAgentToken,
	queryChangeLog,
} from "../../src/admin";
import {
	clearAdminBot,
	designateAdminBot,
	getAdminBotConfig,
	issueAdminBotToken,
	revokeAdminBotToken,
	setAdminBotReadBodies,
	setAdminBotSuperadmin,
} from "../../src/adminbot";
import { authenticate, hashToken } from "../../src/auth";
import { newId } from "../../src/db";
import type { Agent } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { DAY_MS, seedAgent, T0 } from "../helpers/fixtures";

const OWNER: ChangeActor = { actorType: "owner", actorId: "owner@example.com" };

let db: D1Database;
let muse: Agent;
let grok: Agent;

beforeEach(async () => {
	db = await createTestDb();
	muse = await seedAgent(db, { name: "muse" });
	grok = await seedAgent(db, { name: "grok" });
});

async function assertNoTokenSecretLeak(token: string): Promise<void> {
	const tokenHash = await hashToken(token);
	const bodyOnly = token.slice("paab_".length);
	const [tokenRows, changeRows, auditRows] = await db.batch([
		db.prepare("SELECT * FROM tokens"),
		db.prepare("SELECT * FROM change_log"),
		db.prepare("SELECT * FROM audit_log"),
	]);
	const tokensJson = JSON.stringify(tokenRows.results);
	const changesJson = JSON.stringify(changeRows.results);
	expect(tokensJson).not.toContain(token);
	expect(tokensJson).not.toContain(bodyOnly);
	expect(changesJson).not.toContain(token);
	expect(changesJson).not.toContain(bodyOnly);
	expect(changesJson).not.toContain(tokenHash);
	expect(JSON.stringify(auditRows.results)).not.toContain(token);
}

describe("admin bot config and designation", () => {
	it("returns unconfigured defaults when admin_bot_config has no row", async () => {
		expect(await getAdminBotConfig(db)).toEqual({
			agentId: null,
			readBodies: false,
			superadminUntil: null,
			updatedAt: 0,
		});
	});

	it("designates a bot, logs change_log, and is a no-op when re-designating the same bot", async () => {
		const res = await designateAdminBot(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0,
		});
		expect(res.ok).toBe(true);
		if (!res.ok || !res.data.changed) return;

		expect(res.data.previousAgentId).toBeNull();
		expect(res.data.config).toEqual({
			agentId: muse.id,
			readBodies: false,
			superadminUntil: null,
			updatedAt: T0,
		});
		expect(await getAdminBotConfig(db)).toEqual(res.data.config);

		const issued = await issueAdminBotToken(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 1,
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;

		const again = await designateAdminBot(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 2,
		});
		expect(again).toEqual({
			ok: true,
			data: {
				config: res.data.config,
				agent: muse,
				previousAgentId: muse.id,
				changed: false,
			},
			changeId: null,
		});
		expect(
			await authenticate(db, `Bearer ${issued.data.token}`, "admin"),
		).toMatchObject({ ok: true, agent: { id: muse.id } });

		const logs = await queryChangeLog(db);
		expect(logs.map((entry) => entry.action)).toEqual([
			"token_issued",
			"admin_bot_designated",
		]);
		expect(logs[1]).toMatchObject({
			actorType: "owner",
			actorId: OWNER.actorId,
			action: "admin_bot_designated",
			targetType: "admin_bot",
			targetId: muse.id,
		});
		expect(JSON.parse(logs[1]?.beforeJson ?? "null")).toEqual({
			agentId: null,
			readBodies: false,
			superadminUntil: null,
			updatedAt: 0,
		});
		expect(JSON.parse(logs[1]?.afterJson ?? "null")).toEqual(res.data.config);
		await assertNoTokenSecretLeak(issued.data.token);
	});

	it("returns not_found when designating a missing agent without writing anything", async () => {
		const res = await designateAdminBot(db, {
			agentId: newId(),
			actor: OWNER,
			now: T0,
		});
		expect(res).toMatchObject({ ok: false, code: "not_found" });
		expect(await getAdminBotConfig(db)).toEqual({
			agentId: null,
			readBodies: false,
			superadminUntil: null,
			updatedAt: 0,
		});
		expect(await queryChangeLog(db)).toHaveLength(0);
	});

	it("revokes the first bot's admin token and resets switches when designating a second bot", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });
		const museAdmin = await issueAdminBotToken(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 1,
		});
		const musePart = await issueAgentToken(db, {
			agentId: muse.id,
			purpose: "participant",
			actor: OWNER,
			now: T0 + 2,
		});
		const museUnread = await issueAgentToken(db, {
			agentId: muse.id,
			purpose: "unread_count",
			actor: OWNER,
			now: T0 + 3,
		});
		expect(museAdmin.ok && musePart.ok && museUnread.ok).toBe(true);
		if (!museAdmin.ok || !musePart.ok || !museUnread.ok) return;

		await db
			.prepare(
				"UPDATE admin_bot_config SET read_bodies = 1, superadmin_until = ? WHERE id = 1",
			)
			.bind(T0 + 7 * DAY_MS)
			.run();

		const switched = await designateAdminBot(db, {
			agentId: grok.id,
			actor: OWNER,
			now: T0 + 10,
		});
		expect(switched.ok).toBe(true);
		if (!switched.ok || !switched.data.changed) return;

		expect(switched.data.previousAgentId).toBe(muse.id);
		expect(switched.data.config).toEqual({
			agentId: grok.id,
			readBodies: false,
			superadminUntil: null,
			updatedAt: T0 + 10,
		});
		expect(await getAdminBotConfig(db)).toEqual(switched.data.config);

		expect(
			await authenticate(db, `Bearer ${museAdmin.data.token}`, "admin"),
		).toMatchObject({ ok: false, reason: "token_revoked" });
		expect(
			await authenticate(db, `Bearer ${musePart.data.token}`, "participant"),
		).toMatchObject({ ok: true, agent: { id: muse.id } });
		expect(
			await authenticate(db, `Bearer ${museUnread.data.token}`, "unread_count"),
		).toMatchObject({ ok: true, agent: { id: muse.id } });

		const [latest] = await queryChangeLog(db, { limit: 1 });
		expect(latest?.action).toBe("admin_bot_designated");
		expect(JSON.parse(latest?.beforeJson ?? "null")).toMatchObject({
			agentId: muse.id,
			readBodies: true,
			superadminUntil: T0 + 7 * DAY_MS,
		});
		expect(JSON.parse(latest?.afterJson ?? "null")).toEqual(
			switched.data.config,
		);
	});

	it("clears designation, revokes admin tokens, resets switches, and is a no-op when already cleared", async () => {
		const noop = await clearAdminBot(db, { actor: OWNER, now: T0 });
		expect(noop).toEqual({
			ok: true,
			data: {
				config: {
					agentId: null,
					readBodies: false,
					superadminUntil: null,
					updatedAt: 0,
				},
				previousAgentId: null,
				changed: false,
			},
			changeId: null,
		});
		expect(await queryChangeLog(db)).toHaveLength(0);

		await designateAdminBot(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 1,
		});
		const issued = await issueAdminBotToken(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 2,
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;

		await db
			.prepare(
				"UPDATE admin_bot_config SET read_bodies = 1, superadmin_until = ? WHERE id = 1",
			)
			.bind(T0 + DAY_MS)
			.run();

		const cleared = await clearAdminBot(db, { actor: OWNER, now: T0 + 3 });
		expect(cleared.ok).toBe(true);
		if (!cleared.ok || !cleared.data.changed) return;
		expect(cleared.data.previousAgentId).toBe(muse.id);
		expect(cleared.data.config).toEqual({
			agentId: null,
			readBodies: false,
			superadminUntil: null,
			updatedAt: T0 + 3,
		});

		expect(
			await authenticate(db, `Bearer ${issued.data.token}`, "admin"),
		).toMatchObject({ ok: false, reason: "token_revoked" });

		const noopAfterClear = await clearAdminBot(db, {
			actor: OWNER,
			now: T0 + 4,
		});
		expect(noopAfterClear.ok).toBe(true);
		if (!noopAfterClear.ok) return;
		expect(noopAfterClear.data.changed).toBe(false);
		expect(noopAfterClear.changeId).toBeNull();

		const [latest] = await queryChangeLog(db, { limit: 1 });
		expect(latest).toMatchObject({
			action: "admin_bot_cleared",
			targetType: "admin_bot",
			targetId: muse.id,
		});
		expect(JSON.parse(latest?.afterJson ?? "null")).toEqual(
			cleared.data.config,
		);
	});

	it("resets admin_bot_config cleanly when the designated agent is deleted", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });
		await db
			.prepare(
				"UPDATE admin_bot_config SET read_bodies = 1, superadmin_until = ? WHERE id = 1",
			)
			.bind(T0 + DAY_MS)
			.run();

		const del = await deleteAgent(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 5,
		});
		expect(del.ok).toBe(true);
		expect(await getAdminBotConfig(db)).toEqual({
			agentId: null,
			readBodies: false,
			superadminUntil: null,
			updatedAt: T0 + 5,
		});
	});
});

describe("issueAdminBotToken and revokeAdminBotToken", () => {
	it("refuses agents that are not designated or do not exist", async () => {
		expect(
			await issueAdminBotToken(db, {
				agentId: muse.id,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_admin_bot" });

		expect(
			await revokeAdminBotToken(db, {
				agentId: muse.id,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_admin_bot" });

		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });

		expect(
			await issueAdminBotToken(db, {
				agentId: grok.id,
				actor: OWNER,
				now: T0 + 1,
			}),
		).toMatchObject({ ok: false, code: "not_admin_bot" });

		expect(
			await revokeAdminBotToken(db, {
				agentId: grok.id,
				actor: OWNER,
				now: T0 + 1,
			}),
		).toMatchObject({ ok: false, code: "not_admin_bot" });

		expect(
			await issueAdminBotToken(db, {
				agentId: newId(),
				actor: OWNER,
				now: T0 + 1,
			}),
		).toMatchObject({ ok: false, code: "not_found" });
	});

	it("issues, reissues, and revokes purpose=admin tokens without leaking secrets", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });

		const first = await issueAdminBotToken(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 1,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.data.revokedPrevious).toBe(false);
		await assertNoTokenSecretLeak(first.data.token);

		const second = await issueAdminBotToken(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 2,
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.revokedPrevious).toBe(true);
		await assertNoTokenSecretLeak(second.data.token);

		expect(
			await authenticate(db, `Bearer ${first.data.token}`, "admin"),
		).toMatchObject({ ok: false, reason: "token_revoked" });
		expect(
			await authenticate(db, `Bearer ${second.data.token}`, "admin"),
		).toMatchObject({ ok: true, agent: { id: muse.id } });

		const revoked = await revokeAdminBotToken(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 3,
		});
		expect(revoked.ok).toBe(true);
		if (!revoked.ok) return;
		expect(revoked.data.revokedCount).toBe(1);
		expect(
			await authenticate(db, `Bearer ${second.data.token}`, "admin"),
		).toMatchObject({ ok: false, reason: "token_revoked" });
	});
});

function interceptFirstBatch(
	baseDb: D1Database,
	beforeBatch: () => Promise<void>,
): D1Database {
	let intercepted = false;
	return new Proxy(baseDb, {
		get(target, prop) {
			if (prop === "batch") {
				return async <T = unknown>(
					statements: D1PreparedStatement[],
				): Promise<D1Result<T>[]> => {
					if (!intercepted) {
						intercepted = true;
						await beforeBatch();
					}
					return target.batch<T>(statements);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("concurrent re-designation during switch updates", () => {
	it("aborts setAdminBotReadBodies with not_admin_bot, leaves new bot switches OFF, and writes 0 change_log entries", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });

		let logsAfterRedesignate = 0;
		const racedDb = interceptFirstBatch(db, async () => {
			const redesignated = await designateAdminBot(db, {
				agentId: grok.id,
				actor: OWNER,
				now: T0 + 5,
			});
			expect(redesignated.ok).toBe(true);
			logsAfterRedesignate = (await queryChangeLog(db)).length;
		});

		const res = await setAdminBotReadBodies(racedDb, {
			enabled: true,
			actor: OWNER,
			now: T0 + 10,
		});
		expect(res).toMatchObject({ ok: false, code: "not_admin_bot" });
		expect(await getAdminBotConfig(db)).toEqual({
			agentId: grok.id,
			readBodies: false,
			superadminUntil: null,
			updatedAt: T0 + 5,
		});

		const logs = await queryChangeLog(db);
		expect(logs).toHaveLength(logsAfterRedesignate);
		expect(
			logs.filter((entry) => entry.action === "admin_bot_switches_updated"),
		).toHaveLength(0);
	});

	it("aborts setAdminBotSuperadmin with not_admin_bot, leaves new bot switches OFF, and writes 0 change_log entries", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });

		let logsAfterRedesignate = 0;
		const racedDb = interceptFirstBatch(db, async () => {
			const redesignated = await designateAdminBot(db, {
				agentId: grok.id,
				actor: OWNER,
				now: T0 + 5,
			});
			expect(redesignated.ok).toBe(true);
			logsAfterRedesignate = (await queryChangeLog(db)).length;
		});

		const res = await setAdminBotSuperadmin(racedDb, {
			mode: "days",
			days: 7,
			actor: OWNER,
			now: T0 + 10,
		});
		expect(res).toMatchObject({ ok: false, code: "not_admin_bot" });
		expect(await getAdminBotConfig(db)).toEqual({
			agentId: grok.id,
			readBodies: false,
			superadminUntil: null,
			updatedAt: T0 + 5,
		});

		const logs = await queryChangeLog(db);
		expect(logs).toHaveLength(logsAfterRedesignate);
		expect(
			logs.filter((entry) => entry.action === "admin_bot_switches_updated"),
		).toHaveLength(0);
	});
});
