import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	listAllowRulesGrouped,
	listCategoriesWithUsage,
	queryChangeLog,
	revertAdminBotChange,
} from "../../src/admin";
import {
	clearAdminBot,
	DEFAULT_SUPERADMIN_DAYS,
	designateAdminBot,
	getAdminBotConfig,
	getSuperadminState,
	handleAdminMcpRequest,
	isSuperadminActive,
	issueAdminBotToken,
	listProposals,
	MAX_SUPERADMIN_DAYS,
	SUPERADMIN_DURATION_PRESETS,
	SUPERADMIN_PERMANENT,
	setAdminBotReadBodies,
	setAdminBotSuperadmin,
	wouldEnableBothOptionalPermissions,
} from "../../src/adminbot";
import { queryAuditLog } from "../../src/audit";
import { type AgentRow, agentFromRow } from "../../src/db";
import type { McpEnv } from "../../src/mcp/config";
import type { AdminBotConfig, Agent, Category } from "../../src/types";
import { createTestDb } from "../helpers/db";
import {
	DAY_MS,
	HOUR_MS,
	seedAgent,
	seedCategory,
	T0,
} from "../helpers/fixtures";
import { call } from "../mcp/support";

const ADMIN_MCP_URL = "https://paab.test/mcp/admin";
const OWNER: ChangeActor = { actorType: "owner", actorId: "owner@example.com" };

let db: D1Database;
let muse: Agent;
let grok: Agent;
let carol: Agent;
let schedule: Category;
let adminToken: string;

beforeEach(async () => {
	db = await createTestDb();
	muse = await seedAgent(db, { name: "muse", dailyQuestionLimit: 20 });
	grok = await seedAgent(db, {
		name: "grok",
		description: "grok description",
		dailyQuestionLimit: 10,
	});
	carol = await seedAgent(db, {
		name: "carol",
		status: "suspended",
		dailyQuestionLimit: 5,
	});
	schedule = await seedCategory(db, { name: "schedule" });

	await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });
	const issued = await issueAdminBotToken(db, {
		agentId: muse.id,
		actor: OWNER,
		now: T0,
	});
	if (!issued.ok) {
		throw new Error("Expected admin token to be issued");
	}
	adminToken = issued.data.token;
});

async function connectAdmin(
	token: string,
	options: { now?: number; env?: McpEnv } = {},
): Promise<Client> {
	const client = new Client({
		name: "paab-admin-superadmin",
		version: "0.0.0",
	});
	const transport = new StreamableHTTPClientTransport(new URL(ADMIN_MCP_URL), {
		fetch: (input, init) =>
			handleAdminMcpRequest(
				new Request(input, init),
				options.env ?? env,
				options.now ?? T0,
			),
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	return client;
}

async function loadAgent(id: string): Promise<Agent> {
	const row = await db
		.prepare("SELECT * FROM agents WHERE id = ?")
		.bind(id)
		.first<AgentRow>();
	if (row === null) throw new Error(`Agent not found: ${id}`);
	return agentFromRow(row);
}

function extractChangeId(text: string): number {
	const match = /^change_id: (\d+)$/m.exec(text);
	if (!match?.[1]) {
		throw new Error(`Expected change_id in output:\n${text}`);
	}
	return Number(match[1]);
}

describe("superadmin config state helpers and mutation rules", () => {
	it("exports expected constants and classifies off, active, expired, and permanent states", () => {
		expect(SUPERADMIN_PERMANENT).toBe(0);
		expect(DEFAULT_SUPERADMIN_DAYS).toBe(7);
		expect(SUPERADMIN_DURATION_PRESETS).toEqual([1, 3, 7, 14, 30]);
		expect(MAX_SUPERADMIN_DAYS).toBe(365);

		const base: AdminBotConfig = {
			agentId: muse.id,
			readBodies: false,
			superadminUntil: null,
			updatedAt: T0,
		};

		expect(getSuperadminState(base, T0)).toEqual({ kind: "off" });
		expect(isSuperadminActive(base, T0)).toBe(false);

		const timed: AdminBotConfig = {
			...base,
			superadminUntil: T0 + 7 * DAY_MS,
		};
		expect(getSuperadminState(timed, T0)).toEqual({
			kind: "active",
			until: T0 + 7 * DAY_MS,
			remainingMs: 7 * DAY_MS,
		});
		expect(isSuperadminActive(timed, T0 + 7 * DAY_MS - 1)).toBe(true);
		expect(getSuperadminState(timed, T0 + 7 * DAY_MS)).toEqual({
			kind: "expired",
			expiredAt: T0 + 7 * DAY_MS,
		});
		expect(isSuperadminActive(timed, T0 + 7 * DAY_MS)).toBe(false);
		expect(isSuperadminActive(timed, T0 + 8 * DAY_MS)).toBe(false);

		const permanent: AdminBotConfig = {
			...base,
			superadminUntil: SUPERADMIN_PERMANENT,
		};
		expect(getSuperadminState(permanent, T0 + 1000 * DAY_MS)).toEqual({
			kind: "permanent",
		});
		expect(isSuperadminActive(permanent, T0 + 1000 * DAY_MS)).toBe(true);
	});

	it("evaluates wouldEnableBothOptionalPermissions only on transitions into both-on", () => {
		const offBoth: AdminBotConfig = {
			agentId: muse.id,
			readBodies: false,
			superadminUntil: null,
			updatedAt: T0,
		};
		expect(
			wouldEnableBothOptionalPermissions(offBoth, T0, { readBodies: true }),
		).toBe(false);
		expect(
			wouldEnableBothOptionalPermissions(offBoth, T0, {
				superadminActive: true,
			}),
		).toBe(false);

		const readBodiesOnly: AdminBotConfig = { ...offBoth, readBodies: true };
		expect(
			wouldEnableBothOptionalPermissions(readBodiesOnly, T0, {
				superadminActive: true,
			}),
		).toBe(true);
		expect(
			wouldEnableBothOptionalPermissions(readBodiesOnly, T0, {
				readBodies: true,
			}),
		).toBe(false);

		const superadminTimed: AdminBotConfig = {
			...offBoth,
			superadminUntil: T0 + DAY_MS,
		};
		expect(
			wouldEnableBothOptionalPermissions(superadminTimed, T0, {
				readBodies: true,
			}),
		).toBe(true);
		// Expired superadmin is inactive, so enabling read_bodies is NOT transitioning into both-on.
		expect(
			wouldEnableBothOptionalPermissions(superadminTimed, T0 + DAY_MS, {
				readBodies: true,
			}),
		).toBe(false);

		const bothAlreadyOn: AdminBotConfig = {
			...offBoth,
			readBodies: true,
			superadminUntil: T0 + DAY_MS,
		};
		// Extending already-active superadmin while read_bodies is ON does not re-trigger confirm.
		expect(
			wouldEnableBothOptionalPermissions(bothAlreadyOn, T0 + HOUR_MS, {
				superadminActive: true,
			}),
		).toBe(false);
		// Re-enabling after expiry while read_bodies is ON DOES transition into both-on.
		expect(
			wouldEnableBothOptionalPermissions(bothAlreadyOn, T0 + DAY_MS, {
				superadminActive: true,
			}),
		).toBe(true);
	});

	it("sets timed (default 7 days), permanent, and off states with owner-only enforcement and change_log", async () => {
		const defaultTimed = await setAdminBotSuperadmin(db, {
			mode: "days",
			actor: OWNER,
			now: T0 + 10,
		});
		expect(defaultTimed.ok).toBe(true);
		if (!defaultTimed.ok) return;
		expect(defaultTimed.data.changed).toBe(true);
		expect(defaultTimed.data.config.superadminUntil).toBe(
			T0 + 10 + DEFAULT_SUPERADMIN_DAYS * DAY_MS,
		);
		expect(defaultTimed.changeId).toBeGreaterThan(0);

		// Invalid durations rejected.
		for (const badDays of [0, -1, 1.5, MAX_SUPERADMIN_DAYS + 1, Number.NaN]) {
			const bad = await setAdminBotSuperadmin(db, {
				mode: "days",
				days: badDays,
				actor: OWNER,
				now: T0 + 20,
			});
			expect(bad).toMatchObject({ ok: false, code: "invalid_input" });
		}

		// Permanent mode and idempotent no-op.
		const perm = await setAdminBotSuperadmin(db, {
			mode: "permanent",
			actor: OWNER,
			now: T0 + 30,
		});
		expect(perm.ok).toBe(true);
		if (!perm.ok) return;
		expect(perm.data.changed).toBe(true);
		expect(perm.data.config.superadminUntil).toBe(SUPERADMIN_PERMANENT);

		const permNoop = await setAdminBotSuperadmin(db, {
			mode: "permanent",
			actor: OWNER,
			now: T0 + 40,
		});
		expect(permNoop.ok).toBe(true);
		if (!permNoop.ok) return;
		expect(permNoop.data.changed).toBe(false);
		expect(permNoop.changeId).toBeNull();

		// Off mode and idempotent no-op.
		const off = await setAdminBotSuperadmin(db, {
			mode: "off",
			actor: OWNER,
			now: T0 + 50,
		});
		expect(off.ok).toBe(true);
		if (!off.ok) return;
		expect(off.data.changed).toBe(true);
		expect(off.data.config.superadminUntil).toBeNull();

		const offNoop = await setAdminBotSuperadmin(db, {
			mode: "off",
			actor: OWNER,
			now: T0 + 60,
		});
		expect(offNoop.ok).toBe(true);
		if (!offNoop.ok) return;
		expect(offNoop.data.changed).toBe(false);
		expect(offNoop.changeId).toBeNull();

		// Rejects when no admin bot is designated.
		await clearAdminBot(db, { actor: OWNER, now: T0 + 70 });
		const unset = await setAdminBotSuperadmin(db, {
			mode: "days",
			days: 7,
			actor: OWNER,
			now: T0 + 80,
		});
		expect(unset).toMatchObject({ ok: false, code: "not_admin_bot" });

		const switchLogs = (await queryChangeLog(db)).filter(
			(e) => e.action === "admin_bot_switches_updated",
		);
		expect(switchLogs).toHaveLength(3);
		for (const entry of switchLogs) {
			expect(entry.actorType).toBe("owner");
			expect(entry.actorId).toBe(OWNER.actorId);
			expect(entry.targetType).toBe("admin_bot");
			expect(entry.targetId).toBe(muse.id);
		}
	});
});

describe("superadmin MCP loosening execution, expiry, undo, and fixed prohibitions", () => {
	it("submits pending proposals when superadmin is OFF or EXPIRED without waiting for cron", async () => {
		// 1. Default OFF: all 4 loosening tools only create pending proposals.
		const clientOff = await connectAdmin(adminToken, { now: T0 + 10 });

		const r1 = await call(clientOff, "propose_allow_rule", {
			from: "muse",
			to: "grok",
			category: "schedule",
			reason: "off allow rule",
		});
		const r2 = await call(clientOff, "propose_category", {
			name: "travel",
			reason: "off category",
		});
		const r3 = await call(clientOff, "propose_raise_daily_limit", {
			agent: "grok",
			new_limit: 25,
			reason: "off limit",
		});
		const r4 = await call(clientOff, "propose_resume_agent", {
			agent: "carol",
			reason: "off resume",
		});

		for (const res of [r1, r2, r3, r4]) {
			expect(res.isError).toBe(false);
			expect(res.text).toContain("proposal_id:");
			expect(res.text).toContain("status: pending");
			expect(res.text).not.toContain("mode: executed_immediately");
		}
		expect(await listAllowRulesGrouped(db)).toEqual([]);
		expect(
			(await listCategoriesWithUsage(db)).map((c) => c.category.name),
		).not.toContain("travel");
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(10);
		expect((await loadAgent(carol.id)).status).toBe("suspended");
		expect(
			await listProposals(db, { status: "pending", now: T0 + 10 }),
		).toHaveLength(4);

		// 2. Enable timed superadmin for 7 days, then advance clock to exact expiry (now === superadminUntil) WITHOUT any cron sweep.
		const enabled = await setAdminBotSuperadmin(db, {
			mode: "days",
			days: 7,
			actor: OWNER,
			now: T0 + 100,
		});
		expect(enabled.ok).toBe(true);
		const expiredAt = T0 + 100 + 7 * DAY_MS;

		const clientExpired = await connectAdmin(adminToken, { now: expiredAt });
		const e1 = await call(clientExpired, "propose_allow_rule", {
			from: "grok",
			to: "muse",
			category: "schedule",
			reason: "expired allow rule",
		});
		const e2 = await call(clientExpired, "propose_category", {
			name: "finance",
			reason: "expired category",
		});
		const e3 = await call(clientExpired, "propose_raise_daily_limit", {
			agent: "grok",
			new_limit: 30,
			reason: "expired limit",
		});
		const e4 = await call(clientExpired, "propose_resume_agent", {
			agent: "carol",
			reason: "expired resume",
		});

		for (const res of [e1, e2, e3, e4]) {
			expect(res.isError).toBe(false);
			expect(res.text).toContain("proposal_id:");
			expect(res.text).toContain("status: pending");
			expect(res.text).not.toContain("mode: executed_immediately");
		}
		// Still no live changes applied after expiry!
		expect(await listAllowRulesGrouped(db)).toEqual([]);
		expect(
			(await listCategoriesWithUsage(db)).map((c) => c.category.name),
		).not.toContain("finance");
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(10);
		expect((await loadAgent(carol.id)).status).toBe("suspended");

		// Confirm superadmin_until in DB is still the expired timestamp (proving no cron cleanup was needed).
		expect((await getAdminBotConfig(db)).superadminUntil).toBe(expiredAt);
	});

	it("applies all 4 loosening tools immediately during 7-day timed superadmin, records admin_bot change_log, and reverts each in 1 click", async () => {
		const enabled = await setAdminBotSuperadmin(db, {
			mode: "days",
			actor: OWNER,
			now: T0 + 100,
		});
		expect(enabled.ok).toBe(true);
		const expiresAt = T0 + 100 + 7 * DAY_MS;

		// Even 1 ms before expiry, superadmin is still active.
		const activeNow = expiresAt - 1;
		const client = await connectAdmin(adminToken, { now: activeNow });

		const allowRes = await call(client, "propose_allow_rule", {
			from: "muse",
			to: "grok",
			category: "schedule",
			reason: "timed immediate allow rule",
		});
		expect(allowRes.isError).toBe(false);
		expect(allowRes.text).toContain("mode: executed_immediately");
		expect(allowRes.text).toContain("status: applied");
		expect(allowRes.text).toContain("<untrusted_external_data boundary=");
		const allowChangeId = extractChangeId(allowRes.text);

		const catRes = await call(client, "propose_category", {
			name: "travel",
			reason: "timed immediate category",
		});
		expect(catRes.isError).toBe(false);
		expect(catRes.text).toContain("mode: executed_immediately");
		expect(catRes.text).toContain("status: applied");
		const catChangeId = extractChangeId(catRes.text);

		const limitRes = await call(client, "propose_raise_daily_limit", {
			agent: "grok",
			new_limit: 25,
			reason: "timed immediate limit",
		});
		expect(limitRes.isError).toBe(false);
		expect(limitRes.text).toContain("mode: executed_immediately");
		expect(limitRes.text).toContain("status: applied");
		expect(limitRes.text).toContain("previous_limit: 10");
		expect(limitRes.text).toContain("daily_question_limit: 25");
		const limitChangeId = extractChangeId(limitRes.text);

		const resumeRes = await call(client, "propose_resume_agent", {
			agent: "carol",
			reason: "timed immediate resume",
		});
		expect(resumeRes.isError).toBe(false);
		expect(resumeRes.text).toContain("mode: executed_immediately");
		expect(resumeRes.text).toContain("status: applied");
		expect(resumeRes.text).toContain("agent_status: active");
		const resumeChangeId = extractChangeId(resumeRes.text);

		// No pending proposals were created.
		expect(await listProposals(db, { now: activeNow })).toEqual([]);

		// All 4 changes took effect immediately.
		expect(await listAllowRulesGrouped(db)).toHaveLength(1);
		expect(
			(await listCategoriesWithUsage(db)).map((c) => c.category.name),
		).toContain("travel");
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(25);
		expect((await loadAgent(carol.id)).status).toBe("active");

		// change_log recorded actorType="admin_bot", actorId=muse.id, approverId=null.
		const botLogs = await queryChangeLog(db, { actorType: "admin_bot" });
		expect(botLogs.map((e) => e.id).sort((a, b) => a - b)).toEqual(
			[allowChangeId, catChangeId, limitChangeId, resumeChangeId].sort(
				(a, b) => a - b,
			),
		);
		for (const entry of botLogs) {
			expect(entry.actorType).toBe("admin_bot");
			expect(entry.actorId).toBe(muse.id);
			expect(entry.approverId).toBeNull();
		}

		// Audit log recorded admin_tool_called for all 4 calls with target metadata.
		const auditCalled = (await queryAuditLog(db)).filter(
			(e) => e.eventType === "admin_tool_called",
		);
		expect(auditCalled).toHaveLength(4);
		expect(auditCalled).toContainEqual(
			expect.objectContaining({
				toAgentId: grok.id,
				categoryId: schedule.id,
			}),
		);

		// Each of the 4 changes can be reverted in 1 click by revertAdminBotChange.
		for (const [index, changeId] of [
			allowChangeId,
			catChangeId,
			limitChangeId,
			resumeChangeId,
		].entries()) {
			const reverted = await revertAdminBotChange(db, {
				changeId,
				actor: OWNER,
				now: expiresAt + index + 1,
			});
			expect(reverted.ok).toBe(true);
		}

		expect(await listAllowRulesGrouped(db)).toEqual([]);
		expect(
			(await listCategoriesWithUsage(db)).map((c) => c.category.name),
		).not.toContain("travel");
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(10);
		expect((await loadAgent(carol.id)).status).toBe("suspended");
	});

	it("applies all 4 loosening tools immediately while permanent superadmin is active and reverts each in 1 click", async () => {
		const perm = await setAdminBotSuperadmin(db, {
			mode: "permanent",
			actor: OWNER,
			now: T0 + 100,
		});
		expect(perm.ok).toBe(true);

		const farFuture = T0 + 400 * DAY_MS;
		const client = await connectAdmin(adminToken, { now: farFuture });

		const allowRes = await call(client, "propose_allow_rule", {
			from: "muse",
			to: "grok",
			category: "schedule",
			reason: "permanent allow",
		});
		const catRes = await call(client, "propose_category", {
			name: "notes",
			reason: "permanent category",
		});
		const limitRes = await call(client, "propose_raise_daily_limit", {
			agent: "grok",
			new_limit: 40,
			reason: "permanent limit",
		});
		const resumeRes = await call(client, "propose_resume_agent", {
			agent: "carol",
			reason: "permanent resume",
		});

		for (const res of [allowRes, catRes, limitRes, resumeRes]) {
			expect(res.isError).toBe(false);
			expect(res.text).toContain("mode: executed_immediately");
			expect(res.text).toContain("status: applied");
		}

		// Duplicate allow rule / duplicate category fail cleanly without creating proposals.
		const dupAllow = await call(client, "propose_allow_rule", {
			from: "muse",
			to: "grok",
			category: "schedule",
			reason: "duplicate",
		});
		expect(dupAllow.isError).toBe(true);
		const dupCat = await call(client, "propose_category", {
			name: "notes",
			reason: "duplicate",
		});
		expect(dupCat.isError).toBe(true);

		for (const [index, res] of [
			allowRes,
			catRes,
			limitRes,
			resumeRes,
		].entries()) {
			const reverted = await revertAdminBotChange(db, {
				changeId: extractChangeId(res.text),
				actor: OWNER,
				now: farFuture + index + 1,
			});
			expect(reverted.ok).toBe(true);
		}

		expect(await listAllowRulesGrouped(db)).toEqual([]);
		expect(
			(await listCategoriesWithUsage(db)).map((c) => c.category.name),
		).not.toContain("notes");
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(10);
		expect((await loadAgent(carol.id)).status).toBe("suspended");
	});

	it("keeps prohibited operations impossible even while permanent superadmin is active", async () => {
		const perm = await setAdminBotSuperadmin(db, {
			mode: "permanent",
			actor: OWNER,
			now: T0 + 100,
		});
		expect(perm.ok).toBe(true);

		const client = await connectAdmin(adminToken, { now: T0 + 200 });
		const { tools } = await client.listTools();
		const toolNames = tools.map((t) => t.name);

		expect(toolNames).toEqual([
			"view_audit_log",
			"suspend_agent",
			"revoke_allow_rule",
			"lower_daily_limit",
			"propose_allow_rule",
			"propose_category",
			"propose_raise_daily_limit",
			"propose_resume_agent",
			"list_proposals",
			"list_pending_descriptions",
			"review_description",
		]);
		for (const name of toolNames) {
			expect(name).not.toMatch(
				/token|designate|clear_admin|register|delete_agent|read_bodies|superadmin|switch|audit.*(delete|disable|clear)/i,
			);
		}

		// Admin bot actor cannot call setAdminBotSuperadmin or setAdminBotReadBodies directly either.
		const botActor: ChangeActor = { actorType: "admin_bot", actorId: muse.id };
		const logsBefore = await queryChangeLog(db);

		const botSetDays = await setAdminBotSuperadmin(db, {
			mode: "days",
			days: 30,
			actor: botActor,
			now: T0 + 210,
		});
		expect(botSetDays).toEqual({
			ok: false,
			code: "invalid_input",
			message: "最高管理者権限の変更は所有者のみが実行できます",
		});

		const botSetPerm = await setAdminBotSuperadmin(db, {
			mode: "permanent",
			actor: botActor,
			now: T0 + 211,
		});
		expect(botSetPerm).toMatchObject({ ok: false, code: "invalid_input" });

		const botSetOff = await setAdminBotSuperadmin(db, {
			mode: "off",
			actor: botActor,
			now: T0 + 212,
		});
		expect(botSetOff).toMatchObject({ ok: false, code: "invalid_input" });

		const botSetReadBodies = await setAdminBotReadBodies(db, {
			enabled: true,
			actor: botActor,
			now: T0 + 213,
		});
		expect(botSetReadBodies).toMatchObject({
			ok: false,
			code: "invalid_input",
		});

		expect((await getAdminBotConfig(db)).superadminUntil).toBe(
			SUPERADMIN_PERMANENT,
		);
		expect((await getAdminBotConfig(db)).readBodies).toBe(false);
		expect(await queryChangeLog(db)).toHaveLength(logsBefore.length);
	});
});
