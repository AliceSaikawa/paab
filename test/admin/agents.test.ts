import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	deleteAgent,
	grantAllowRule,
	queryChangeLog,
	registerAgent,
	resumeAgent,
	suspendAgent,
	updateAgent,
} from "../../src/admin";
import { authenticate, issueToken } from "../../src/auth";
import {
	type AgentRow,
	agentFromRow,
	insertAuditLogEntry,
	insertMessage,
	newId,
} from "../../src/db";
import { DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH } from "../../src/policy";
import type { Agent, Category } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { DAY_MS, seedAgent, seedCategory, T0 } from "../helpers/fixtures";

const OWNER: ChangeActor = { actorType: "owner", actorId: "me" };
const BOT: ChangeActor = {
	actorType: "admin_bot",
	actorId: "bot-1",
	approverId: "me",
};

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
});

async function tableSnapshot(): Promise<unknown[]> {
	const tables = [
		"agents",
		"categories",
		"allow_rules",
		"tokens",
		"messages",
		"audit_log",
		"change_log",
	];
	return Promise.all(
		tables.map(
			async (table) =>
				(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results,
		),
	);
}

describe("registerAgent", () => {
	it("registers an agent, normalizes fields, and records a change_log entry", async () => {
		const res = await registerAgent(db, {
			name: "  か\u3099ーでん  ",
			description: "予定\nと連絡先\tを管理",
			dailyQuestionLimit: 15,
			actor: OWNER,
			now: T0,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(res.data.agent).toMatchObject({
			ownerId: "me",
			name: "がーでん",
			description: "予定\nと連絡先\tを管理",
			status: "active",
			dailyQuestionLimit: 15,
			createdAt: T0,
		});

		const logs = await queryChangeLog(db);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toEqual({
			id: res.changeId,
			occurredAt: T0,
			actorType: "owner",
			actorId: "me",
			approverId: null,
			action: "agent_registered",
			targetType: "agent",
			targetId: res.data.agent.id,
			beforeJson: null,
			afterJson: JSON.stringify(res.data.agent),
			revertedAt: null,
		});
	});

	it("inherits ownerId from an existing agent when omitted", async () => {
		await seedAgent(db, { ownerId: "alice-owner", name: "existing" });
		const res = await registerAgent(db, {
			name: "second",
			dailyQuestionLimit: 0,
			actor: OWNER,
			now: T0 + 1,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.agent.ownerId).toBe("alice-owner");
	});

	it.each([
		["empty name", { name: "   " }, "invalid_name"],
		["comma in name", { name: "a,b" }, "invalid_name"],
		["newline in name", { name: "a\nb" }, "invalid_name"],
		[
			"too long name",
			{ name: "a".repeat(NAME_MAX_LENGTH + 1) },
			"invalid_name",
		],
		[
			"control char in description",
			{ description: "bad\u0007desc" },
			"invalid_description",
		],
		[
			"too long description",
			{ description: "a".repeat(DESCRIPTION_MAX_LENGTH + 1) },
			"invalid_description",
		],
		["negative limit", { dailyQuestionLimit: -1 }, "invalid_limit"],
		["fractional limit", { dailyQuestionLimit: 1.5 }, "invalid_limit"],
		[
			"empty actorId",
			{ actor: { actorType: "owner" as const, actorId: "  " } },
			"invalid_input",
		],
		["NaN timestamp", { now: Number.NaN }, "invalid_input"],
	])(
		"rejects %s without touching D1 or change_log",
		async (_label, patch, expectedCode) => {
			const before = await tableSnapshot();
			const res = await registerAgent(db, {
				name: "valid",
				description: "ok",
				dailyQuestionLimit: 10,
				actor: OWNER,
				now: T0,
				...patch,
			});
			expect(res).toMatchObject({ ok: false, code: expectedCode });
			expect(await tableSnapshot()).toEqual(before);
		},
	);

	it("rejects duplicate names including NFC-equivalent names", async () => {
		await registerAgent(db, {
			name: "が",
			dailyQuestionLimit: 10,
			actor: OWNER,
			now: T0,
		});
		const before = await tableSnapshot();

		const dup = await registerAgent(db, {
			name: "  か\u3099 ",
			dailyQuestionLimit: 5,
			actor: OWNER,
			now: T0 + 1,
		});
		expect(dup).toMatchObject({ ok: false, code: "duplicate_name" });
		expect(await tableSnapshot()).toEqual(before);
	});
});

describe("updateAgent", () => {
	let muse: Agent;

	beforeEach(async () => {
		muse = await seedAgent(db, {
			name: "muse",
			description: "initial",
			dailyQuestionLimit: 20,
		});
	});

	it("updates changed fields and logs before/after JSON", async () => {
		const res = await updateAgent(db, {
			agentId: muse.id,
			name: "  muse-2 ",
			description: "updated desc",
			dailyQuestionLimit: 5,
			actor: BOT,
			now: T0 + 100,
		});
		expect(res.ok).toBe(true);
		if (!res.ok || !res.data.changed) return;

		expect(res.data.agent).toEqual({
			...muse,
			name: "muse-2",
			description: "updated desc",
			dailyQuestionLimit: 5,
		});
		const row = await db
			.prepare("SELECT * FROM agents WHERE id = ?")
			.bind(muse.id)
			.first<AgentRow>();
		expect(row && agentFromRow(row)).toEqual(res.data.agent);

		const logs = await queryChangeLog(db);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			id: res.changeId,
			actorType: "admin_bot",
			actorId: "bot-1",
			approverId: "me",
			action: "agent_updated",
			targetType: "agent",
			targetId: muse.id,
		});
		expect(JSON.parse(logs[0]?.beforeJson ?? "null")).toEqual(muse);
		expect(JSON.parse(logs[0]?.afterJson ?? "null")).toEqual(res.data.agent);
	});

	it("returns changed: false with changeId: null when nothing changed", async () => {
		const before = await tableSnapshot();
		const res = await updateAgent(db, {
			agentId: muse.id,
			name: "  muse ",
			description: "initial",
			dailyQuestionLimit: 20,
			actor: OWNER,
			now: T0 + 10,
		});
		expect(res).toEqual({
			ok: true,
			data: { agent: muse, changed: false },
			changeId: null,
		});
		expect(await tableSnapshot()).toEqual(before);
	});

	it("rejects missing agent, duplicate name, and invalid inputs without writing", async () => {
		await seedAgent(db, { name: "grok" });
		const before = await tableSnapshot();

		expect(
			await updateAgent(db, {
				agentId: newId(),
				name: "new-name",
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_found" });

		expect(
			await updateAgent(db, {
				agentId: muse.id,
				name: "grok",
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "duplicate_name" });

		expect(
			await updateAgent(db, {
				agentId: muse.id,
				name: "bad,name",
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "invalid_name" });

		expect(
			await updateAgent(db, {
				agentId: muse.id,
				dailyQuestionLimit: -5,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "invalid_limit" });

		expect(await tableSnapshot()).toEqual(before);
	});
});

describe("suspendAgent and resumeAgent", () => {
	let muse: Agent;

	beforeEach(async () => {
		muse = await seedAgent(db, { name: "muse" });
	});

	it("suspends and resumes an agent, updating auth state and change_log", async () => {
		const issued = await issueToken(db, {
			agentId: muse.id,
			purpose: "participant",
			now: T0,
		});

		const susp = await suspendAgent(db, {
			agentId: muse.id,
			actor: BOT,
			now: T0 + 1,
		});
		expect(susp.ok).toBe(true);
		if (!susp.ok) return;
		expect(susp.data.agent.status).toBe("suspended");
		expect(
			await authenticate(db, `Bearer ${issued.token}`, "participant"),
		).toMatchObject({ ok: true, suspended: true });

		const res = await resumeAgent(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 2,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.agent.status).toBe("active");
		expect(
			await authenticate(db, `Bearer ${issued.token}`, "participant"),
		).toMatchObject({ ok: true, suspended: false });

		const logs = await queryChangeLog(db);
		expect(logs).toHaveLength(2);
		expect(logs[0]?.action).toBe("agent_resumed");
		expect(logs[1]?.action).toBe("agent_suspended");
	});

	it("refuses no-op status transitions and missing agents without logging", async () => {
		const beforeActive = await tableSnapshot();
		expect(
			await resumeAgent(db, { agentId: muse.id, actor: OWNER, now: T0 }),
		).toMatchObject({ ok: false, code: "already_active" });
		expect(await tableSnapshot()).toEqual(beforeActive);

		await suspendAgent(db, { agentId: muse.id, actor: OWNER, now: T0 + 1 });
		const beforeSuspended = await tableSnapshot();
		expect(
			await suspendAgent(db, { agentId: muse.id, actor: OWNER, now: T0 + 2 }),
		).toMatchObject({ ok: false, code: "already_suspended" });
		expect(
			await suspendAgent(db, { agentId: newId(), actor: OWNER, now: T0 + 2 }),
		).toMatchObject({ ok: false, code: "not_found" });
		expect(await tableSnapshot()).toEqual(beforeSuspended);
	});
});

describe("deleteAgent", () => {
	it("deletes agent, cascades messages/tokens/rules, keeps audit_log, and snapshots allow rules", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const grok = await seedAgent(db, { name: "grok" });
		const schedule: Category = await seedCategory(db, { name: "schedule" });

		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: OWNER,
			now: T0,
		});
		await grantAllowRule(db, {
			fromAgentId: grok.id,
			toAgentId: muse.id,
			categoryId: schedule.id,
			actor: OWNER,
			now: T0 + 1,
		});
		const issued = await issueToken(db, {
			agentId: muse.id,
			purpose: "participant",
			now: T0 + 2,
		});

		const qId = newId();
		await db.batch([
			insertMessage(db, {
				id: qId,
				kind: "question",
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
				body: "q",
				inReplyTo: null,
				status: "answered",
				createdAt: T0 + 3,
				receivedAt: T0 + 4,
				expiresAt: T0 + 7 * DAY_MS,
				bodyDeletedAt: null,
				availableAt: null,
			}),
			insertMessage(db, {
				id: newId(),
				kind: "answer",
				fromAgentId: grok.id,
				toAgentId: muse.id,
				categoryId: schedule.id,
				body: "a",
				inReplyTo: qId,
				status: "sent",
				createdAt: T0 + 4,
				receivedAt: null,
				expiresAt: null,
				bodyDeletedAt: null,
				availableAt: null,
			}),
			insertAuditLogEntry(db, {
				occurredAt: T0 + 3,
				eventType: "question_accepted",
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
				outcome: "ok",
				reasonCode: null,
				messageId: qId,
				body: null,
			}),
		]);

		const del = await deleteAgent(db, {
			agentId: muse.id,
			actor: OWNER,
			now: T0 + 10,
		});
		expect(del.ok).toBe(true);
		if (!del.ok) return;
		expect(del.data.agent).toEqual(muse);
		expect(del.data.deletedAllowRuleCount).toBe(2);

		expect(
			await authenticate(db, `Bearer ${issued.token}`, "participant"),
		).toMatchObject({ ok: false, reason: "token_unknown" });

		const counts = await db.batch([
			db.prepare("SELECT COUNT(*) AS n FROM agents"),
			db.prepare("SELECT COUNT(*) AS n FROM tokens"),
			db.prepare("SELECT COUNT(*) AS n FROM allow_rules"),
			db.prepare("SELECT COUNT(*) AS n FROM messages"),
			db.prepare("SELECT COUNT(*) AS n FROM audit_log"),
		]);
		expect(counts.map((r) => (r.results[0] as { n: number }).n)).toEqual([
			1, 0, 0, 0, 1,
		]);

		const [latest] = await queryChangeLog(db, { limit: 1 });
		expect(latest?.action).toBe("agent_deleted");
		expect(latest?.afterJson).toBeNull();
		const snapshot = JSON.parse(latest?.beforeJson ?? "null") as {
			agent: Agent;
			allowRules: unknown[];
		};
		expect(snapshot.agent).toEqual(muse);
		expect(snapshot.allowRules).toHaveLength(2);
	});

	it("returns not_found for missing agent without touching change_log", async () => {
		const before = await tableSnapshot();
		expect(
			await deleteAgent(db, { agentId: newId(), actor: OWNER, now: T0 }),
		).toMatchObject({ ok: false, code: "not_found" });
		expect(await tableSnapshot()).toEqual(before);
	});
});
