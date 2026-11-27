import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	deleteAgent,
	issueAgentToken,
	queryChangeLog,
} from "../../src/admin";
import {
	approveProposal,
	clearAdminBot,
	createProposal,
	designateAdminBot,
	expireProposals,
	getAdminBotConfig,
	issueAdminBotToken,
	listProposals,
	PROPOSAL_TTL_MS,
	rejectProposal,
	revokeAdminBotToken,
	setAdminBotReadBodies,
	setAdminBotSuperadmin,
} from "../../src/adminbot";
import { authenticate, hashToken } from "../../src/auth";
import { newId, type ProposalRow, proposalFromRow } from "../../src/db";
import type { Agent, Proposal } from "../../src/types";
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

async function loadProposal(id: string): Promise<Proposal> {
	const row = await db
		.prepare("SELECT * FROM proposals WHERE id = ?")
		.bind(id)
		.first<ProposalRow>();
	if (row === null) throw new Error(`Proposal not found: ${id}`);
	return proposalFromRow(row);
}

describe("admin bot designation changes and pending proposals", () => {
	it("rejects active pending proposals on clearAdminBot while leaving approved, rejected, expired, and overdue ones unchanged", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });

		const pPending = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "pending-cat" },
			reason: "Active pending",
			now: T0 + 10 * DAY_MS,
		});
		const pApproved = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "approved-cat" },
			reason: "Already approved",
			now: T0 + 1,
		});
		const pRejected = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "rejected-cat" },
			reason: "Already rejected",
			now: T0 + 2,
		});
		const pExpired = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "expired-cat" },
			reason: "Swept expired",
			now: T0,
		});
		const pOverdue = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "overdue-cat" },
			reason: "Overdue but unswept",
			now: T0 + 100,
		});
		if (
			!pPending.ok ||
			!pApproved.ok ||
			!pRejected.ok ||
			!pExpired.ok ||
			!pOverdue.ok
		) {
			throw new Error("Expected proposals to be created");
		}

		const approved = await approveProposal(db, {
			proposalId: pApproved.data.proposal.id,
			approverId: OWNER.actorId,
			now: T0 + 10,
		});
		const rejected = await rejectProposal(db, {
			proposalId: pRejected.data.proposal.id,
			approverId: "earlier-owner@example.com",
			now: T0 + 11,
		});
		expect(approved.ok && rejected.ok).toBe(true);
		if (!approved.ok) return;

		// Sweep pExpired at its exact deadline while pOverdue is still 100ms before expiry.
		expect(await expireProposals(db, T0 + PROPOSAL_TTL_MS)).toBe(1);

		// At clearNow, pOverdue is overdue (expiresAt <= clearNow) while pPending is still active.
		const clearNow = T0 + PROPOSAL_TTL_MS + 100;
		const cleared = await clearAdminBot(db, { actor: OWNER, now: clearNow });
		expect(cleared.ok && cleared.data.changed).toBe(true);

		expect(await loadProposal(pPending.data.proposal.id)).toMatchObject({
			status: "rejected",
			resolvedAt: clearNow,
			resolvedBy: OWNER.actorId,
			changeLogId: null,
		});
		expect(await loadProposal(pApproved.data.proposal.id)).toMatchObject({
			status: "approved",
			resolvedAt: T0 + 10,
			resolvedBy: OWNER.actorId,
			changeLogId: approved.data.changeId,
		});
		expect(await loadProposal(pRejected.data.proposal.id)).toMatchObject({
			status: "rejected",
			resolvedAt: T0 + 11,
			resolvedBy: "earlier-owner@example.com",
			changeLogId: null,
		});
		expect(await loadProposal(pExpired.data.proposal.id)).toMatchObject({
			status: "expired",
			resolvedAt: T0 + PROPOSAL_TTL_MS,
			resolvedBy: null,
			changeLogId: null,
		});
		expect(
			await listProposals(db, { status: "expired", now: clearNow }),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: pOverdue.data.proposal.id,
					status: "expired",
				}),
			]),
		);
		expect(
			await listProposals(db, { status: "pending", now: clearNow }),
		).toEqual([]);
	});

	it("rejects previous bot's pending proposals when switching to another bot while preserving re-designated same bot's proposals", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });

		const pMuse1 = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "muse-pending-1" },
			reason: "Muse proposal 1",
			now: T0 + 1,
		});
		const pMuseApproved = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "muse-approved" },
			reason: "Muse approved",
			now: T0 + 2,
		});
		if (!pMuse1.ok || !pMuseApproved.ok) {
			throw new Error("Expected muse proposals");
		}
		const approved = await approveProposal(db, {
			proposalId: pMuseApproved.data.proposal.id,
			approverId: OWNER.actorId,
			now: T0 + 3,
		});
		expect(approved.ok).toBe(true);
		if (!approved.ok) return;

		// Re-designating the same bot (muse) must NOT reject its pending proposals.
		const same = await designateAdminBot(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 5,
		});
		expect(same.ok && !same.data.changed).toBe(true);
		expect(await loadProposal(pMuse1.data.proposal.id)).toMatchObject({
			status: "pending",
			resolvedAt: null,
			resolvedBy: null,
		});

		// Switching designation from muse to grok rejects muse's pending proposals
		// without disturbing muse's already-approved proposal.
		const switched = await designateAdminBot(db, {
			agentId: grok.id,
			actor: OWNER,
			now: T0 + 10,
		});
		expect(switched.ok && switched.data.changed).toBe(true);

		expect(await loadProposal(pMuse1.data.proposal.id)).toMatchObject({
			status: "rejected",
			resolvedAt: T0 + 10,
			resolvedBy: OWNER.actorId,
			changeLogId: null,
		});
		expect(await loadProposal(pMuseApproved.data.proposal.id)).toMatchObject({
			status: "approved",
			resolvedAt: T0 + 3,
			resolvedBy: OWNER.actorId,
			changeLogId: approved.data.changeId,
		});

		// Proposals created by the newly designated bot (grok) stay pending when re-designating grok.
		const pGrok = await createProposal(db, {
			proposerAgentId: grok.id,
			payload: { kind: "create_category", name: "grok-pending" },
			reason: "Grok proposal",
			now: T0 + 11,
		});
		expect(pGrok.ok).toBe(true);
		if (!pGrok.ok) return;

		await designateAdminBot(db, {
			agentId: grok.id,
			actor: OWNER,
			now: T0 + 12,
		});
		expect(await loadProposal(pGrok.data.proposal.id)).toMatchObject({
			status: "pending",
			resolvedAt: null,
			resolvedBy: null,
		});
	});
});
