import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	createCategory,
	deleteCategory,
	grantAllowRule,
	queryChangeLog,
	revokeAllowRule,
} from "../../src/admin";
import { insertAuditLogEntry, insertMessage, newId } from "../../src/db";
import { checkQuestion, NAME_MAX_LENGTH } from "../../src/policy";
import type { Agent, AllowRule, Category } from "../../src/types";
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

describe("createCategory and deleteCategory", () => {
	it("creates a normalized category and logs change_log", async () => {
		const res = await createCategory(db, {
			name: "  好み・習慣  ",
			actor: BOT,
			now: T0,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(res.data.category.name).toBe("好み・習慣");
		const logs = await queryChangeLog(db);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			id: res.changeId,
			actorType: "admin_bot",
			approverId: "me",
			action: "category_created",
			targetType: "category",
			targetId: res.data.category.id,
			beforeJson: null,
			afterJson: JSON.stringify(res.data.category),
		});
	});

	it("rejects invalid or duplicate category names without writing", async () => {
		await createCategory(db, { name: "が", actor: OWNER, now: T0 });

		expect(
			await createCategory(db, { name: "  か\u3099 ", actor: OWNER, now: T0 }),
		).toMatchObject({ ok: false, code: "duplicate_name" });
		expect(
			await createCategory(db, { name: "a,b", actor: OWNER, now: T0 }),
		).toMatchObject({ ok: false, code: "invalid_name" });
		expect(
			await createCategory(db, {
				name: "x".repeat(NAME_MAX_LENGTH + 1),
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "invalid_name" });
		expect(await queryChangeLog(db)).toHaveLength(1);
	});

	it("deletes a category, cascades rules and messages, keeps agents/audit, and logs snapshot", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const grok = await seedAgent(db, { name: "grok" });
		const schedule = await seedCategory(db, { name: "schedule" });

		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: OWNER,
			now: T0,
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
				status: "declined",
				createdAt: T0 + 1,
				receivedAt: T0 + 2,
				expiresAt: T0 + 7 * DAY_MS,
				bodyDeletedAt: null,
			}),
			insertMessage(db, {
				id: newId(),
				kind: "rejection",
				fromAgentId: null,
				toAgentId: muse.id,
				categoryId: null,
				body: null,
				inReplyTo: qId,
				status: "sent",
				createdAt: T0 + 2,
				receivedAt: null,
				expiresAt: null,
				bodyDeletedAt: null,
			}),
			insertAuditLogEntry(db, {
				occurredAt: T0 + 1,
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

		const del = await deleteCategory(db, {
			categoryId: schedule.id,
			actor: OWNER,
			now: T0 + 5,
		});
		expect(del.ok).toBe(true);
		if (!del.ok) return;
		expect(del.data).toEqual({ category: schedule, deletedAllowRuleCount: 1 });

		const counts = await db.batch([
			db.prepare("SELECT COUNT(*) AS n FROM agents"),
			db.prepare("SELECT COUNT(*) AS n FROM categories"),
			db.prepare("SELECT COUNT(*) AS n FROM allow_rules"),
			db.prepare("SELECT COUNT(*) AS n FROM messages"),
			db.prepare("SELECT COUNT(*) AS n FROM audit_log"),
		]);
		expect(counts.map((r) => (r.results[0] as { n: number }).n)).toEqual([
			2, 0, 0, 0, 1,
		]);

		const [latest] = await queryChangeLog(db, { limit: 1 });
		expect(latest?.action).toBe("category_deleted");
		expect(latest?.afterJson).toBeNull();
		const snapshot = JSON.parse(latest?.beforeJson ?? "null") as {
			category: Category;
			allowRules: AllowRule[];
		};
		expect(snapshot.category).toEqual(schedule);
		expect(snapshot.allowRules).toHaveLength(1);
	});

	it("returns not_found when deleting a missing category", async () => {
		expect(
			await deleteCategory(db, {
				categoryId: newId(),
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_found" });
		expect(await queryChangeLog(db)).toHaveLength(0);
	});
});

describe("grantAllowRule and revokeAllowRule", () => {
	let muse: Agent;
	let grok: Agent;
	let work: Category;

	beforeEach(async () => {
		muse = await seedAgent(db, { name: "muse" });
		grok = await seedAgent(db, { name: "grok" });
		work = await seedCategory(db, { name: "仕事" });
	});

	it("grants and revokes rules, affecting checkQuestion and recording composite targetId", async () => {
		const grant = await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: work.id,
			actor: BOT,
			now: T0,
		});
		expect(grant.ok).toBe(true);
		if (!grant.ok) return;

		expect(
			await checkQuestion(db, {
				fromAgentId: muse.id,
				toAgentName: "grok",
				categoryName: "仕事",
				now: T0 + 1,
			}),
		).toMatchObject({ allowed: true });

		const revoke = await revokeAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: work.id,
			actor: OWNER,
			now: T0 + 2,
		});
		expect(revoke.ok).toBe(true);

		expect(
			await checkQuestion(db, {
				fromAgentId: muse.id,
				toAgentName: "grok",
				categoryName: "仕事",
				now: T0 + 3,
			}),
		).toMatchObject({ allowed: false, reasonCode: "no_allow_rule" });

		const expectedTargetId = `${muse.id}:${grok.id}:${work.id}`;
		const logs = await queryChangeLog(db, {
			targetType: "allow_rule",
			targetId: expectedTargetId,
		});
		expect(logs).toHaveLength(2);
		expect(logs[0]).toMatchObject({
			action: "allow_rule_revoked",
			afterJson: null,
		});
		expect(JSON.parse(logs[0]?.beforeJson ?? "null")).toEqual(grant.data.rule);
		expect(logs[1]).toMatchObject({
			action: "allow_rule_granted",
			beforeJson: null,
		});
		expect(JSON.parse(logs[1]?.afterJson ?? "null")).toEqual(grant.data.rule);
	});

	it("rejects self_addressed, missing entities, duplicate rule, and missing rule without logging", async () => {
		expect(
			await grantAllowRule(db, {
				fromAgentId: muse.id,
				toAgentId: muse.id,
				categoryId: work.id,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "self_addressed" });

		expect(
			await grantAllowRule(db, {
				fromAgentId: newId(),
				toAgentId: grok.id,
				categoryId: work.id,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_found" });

		expect(
			await grantAllowRule(db, {
				fromAgentId: muse.id,
				toAgentId: newId(),
				categoryId: work.id,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_found" });

		expect(
			await grantAllowRule(db, {
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: newId(),
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_found" });

		expect(
			await revokeAllowRule(db, {
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: work.id,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_found" });

		expect(await queryChangeLog(db)).toHaveLength(0);

		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: work.id,
			actor: OWNER,
			now: T0,
		});
		expect(
			await grantAllowRule(db, {
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: work.id,
				actor: OWNER,
				now: T0 + 1,
			}),
		).toMatchObject({ ok: false, code: "duplicate_rule" });

		expect(await queryChangeLog(db)).toHaveLength(1);
	});
});
