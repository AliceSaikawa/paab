import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	countRecentAdminBotMutations,
	countUnrevertedAdminBotChanges,
	createCategory,
	grantAllowRule,
	issueAgentToken,
	listAdminBotChanges,
	listAgentsWithStatus,
	listAllowRulesGrouped,
	listCategoriesWithUsage,
	MAX_CHANGE_LOG_LIMIT,
	queryChangeLog,
	registerAgent,
	resolveDefaultOwnerId,
	suspendAgent,
} from "../../src/admin";
import { insertChangeLogEntry, insertMessage, newId } from "../../src/db";
import type { Agent, Category } from "../../src/types";
import { createTestDb } from "../helpers/db";
import {
	DAY_MS,
	HOUR_MS,
	seedAgent,
	seedCategory,
	T0,
} from "../helpers/fixtures";

const OWNER: ChangeActor = { actorType: "owner", actorId: "me" };
const BOT: ChangeActor = { actorType: "admin_bot", actorId: "bot-1" };

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
});

describe("queryChangeLog", () => {
	it("orders newest first, filters by fields, and pages with beforeId", async () => {
		const c1 = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 10,
			actor: OWNER,
			now: T0,
		});
		const c2 = await registerAgent(db, {
			name: "grok",
			dailyQuestionLimit: 10,
			actor: BOT,
			now: T0,
		});
		const c3 = await createCategory(db, {
			name: "予定",
			actor: OWNER,
			now: T0 + HOUR_MS,
		});
		if (!c1.ok || !c2.ok || !c3.ok) return;

		const c4 = await suspendAgent(db, {
			agentId: c1.data.agent.id,
			actor: BOT,
			now: T0 + 2 * HOUR_MS,
		});
		if (!c4.ok) return;

		const all = await queryChangeLog(db);
		expect(all.map((e) => e.id)).toEqual([
			c4.changeId,
			c3.changeId,
			c2.changeId,
			c1.changeId,
		]);

		expect(
			(await queryChangeLog(db, { actorType: "admin_bot" })).map((e) => e.id),
		).toEqual([c4.changeId, c2.changeId]);

		expect(
			(
				await queryChangeLog(db, {
					targetType: "agent",
					targetId: c1.data.agent.id,
				})
			).map((e) => e.id),
		).toEqual([c4.changeId, c1.changeId]);

		expect(
			(
				await queryChangeLog(db, {
					occurredFrom: T0 + HOUR_MS,
					occurredBefore: T0 + 2 * HOUR_MS,
				})
			).map((e) => e.id),
		).toEqual([c3.changeId]);

		const page1 = await queryChangeLog(db, { limit: 2 });
		expect(page1.map((e) => e.id)).toEqual([c4.changeId, c3.changeId]);
		const page2 = await queryChangeLog(db, {
			beforeId: page1[1]?.id,
			limit: 2,
		});
		expect(page2.map((e) => e.id)).toEqual([c2.changeId, c1.changeId]);
	});

	it("caps limit at MAX_CHANGE_LOG_LIMIT and rejects invalid filters", async () => {
		await expect(queryChangeLog(db, { limit: 0 })).rejects.toThrow(RangeError);
		await expect(
			queryChangeLog(db, { occurredFrom: Number.NaN }),
		).rejects.toThrow(RangeError);
		await expect(queryChangeLog(db, { beforeId: -1 })).rejects.toThrow(
			RangeError,
		);
		await expect(queryChangeLog(db, { targetId: "" })).rejects.toThrow(
			RangeError,
		);
		expect(
			await queryChangeLog(db, { limit: MAX_CHANGE_LOG_LIMIT + 500 }),
		).toEqual([]);
	});

	it("pages past 100 admin_bot entries with beforeId, filters unrevertedOnly and targetType, and counts recent mutations", async () => {
		const statements: D1PreparedStatement[] = [];
		for (let i = 0; i < 125; i += 1) {
			statements.push(
				insertChangeLogEntry(db, {
					occurredAt: T0 + i * 1000,
					actorType: "admin_bot",
					actorId: "bot-1",
					approverId: null,
					action: i % 5 === 0 ? "allow_rule_revoked" : "agent_updated",
					targetType: i % 5 === 0 ? "allow_rule" : "agent",
					targetId: `target-${i}`,
					beforeJson: "{}",
					afterJson: "{}",
					revertedAt: i >= 15 ? T0 + 999_999 : null,
				}),
			);
		}
		// One owner row and one admin_bot row older than 1 hour.
		statements.push(
			insertChangeLogEntry(db, {
				occurredAt: T0 - HOUR_MS - 1,
				actorType: "admin_bot",
				actorId: "bot-1",
				approverId: null,
				action: "agent_updated",
				targetType: "agent",
				targetId: "old-target",
				beforeJson: "{}",
				afterJson: "{}",
				revertedAt: null,
			}),
			insertChangeLogEntry(db, {
				occurredAt: T0 + 100,
				actorType: "owner",
				actorId: "me",
				approverId: null,
				action: "agent_updated",
				targetType: "agent",
				targetId: "owner-target",
				beforeJson: "{}",
				afterJson: "{}",
				revertedAt: null,
			}),
		);
		await db.batch(statements);

		const page1 = await listAdminBotChanges(db);
		expect(page1).toHaveLength(100);
		// Even with an out-of-order occurred_at (old-target inserted with a higher id), cursor pagination drops zero rows.
		expect(page1[0]?.targetId).toBe("old-target");
		const page2 = await listAdminBotChanges(db, {
			beforeId: page1.at(-1)?.id,
		});
		expect(page2).toHaveLength(26);
		expect(page2.at(-1)?.targetId).toBe("target-0");
		const seenIds = new Set([...page1, ...page2].map((entry) => entry.id));
		expect(seenIds.size).toBe(126);

		const unreverted = await listAdminBotChanges(db, { unrevertedOnly: true });
		expect(unreverted).toHaveLength(16);
		expect(unreverted.every((entry) => entry.revertedAt === null)).toBe(true);
		expect(await countUnrevertedAdminBotChanges(db)).toBe(16);

		const allowRuleOnly = await listAdminBotChanges(db, {
			unrevertedOnly: true,
			targetType: "allow_rule",
		});
		expect(allowRuleOnly).toHaveLength(3);
		expect(allowRuleOnly.map((entry) => entry.targetId)).toEqual([
			"target-10",
			"target-5",
			"target-0",
		]);

		// At T0 + 124_000, the 125 entries at T0..T0+124_000 are within 1 hour, while old-target (T0 - HOUR_MS - 1) is outside.
		expect(await countRecentAdminBotMutations(db, T0 + 124_000)).toBe(125);
		// Exactly 1 hour after the last entry (T0 + 124_000 + HOUR_MS), only the last entry is still >= since.
		expect(await countRecentAdminBotMutations(db, T0 + 124_000 + HOUR_MS)).toBe(
			1,
		);
		// 1ms past 1 hour after the last entry, none remain in the window.
		expect(
			await countRecentAdminBotMutations(db, T0 + 124_000 + HOUR_MS + 1),
		).toBe(0);
	});
});

describe("Stage 2 read helpers", () => {
	it("resolveDefaultOwnerId returns 'me' when empty and first agent's ownerId otherwise", async () => {
		expect(await resolveDefaultOwnerId(db)).toBe("me");
		await seedAgent(db, {
			ownerId: "primary-owner",
			name: "first",
			createdAt: T0,
		});
		await seedAgent(db, {
			ownerId: "other-owner",
			name: "second",
			createdAt: T0 + 1,
		});
		expect(await resolveDefaultOwnerId(db)).toBe("primary-owner");
	});

	it("listAgentsWithStatus returns today's UTC question count and active token metadata only", async () => {
		const beta = await seedAgent(db, { name: "beta" });
		const alpha = await seedAgent(db, { name: "alpha" });
		const cat = await seedCategory(db, { name: "work" });

		const part = await issueAgentToken(db, {
			agentId: alpha.id,
			purpose: "participant",
			actor: OWNER,
			now: T0,
		});
		const unread = await issueAgentToken(db, {
			agentId: alpha.id,
			purpose: "unread_count",
			actor: OWNER,
			now: T0 + 1,
		});
		// Reissuing participant revokes the old one; only the latest should appear.
		const part2 = await issueAgentToken(db, {
			agentId: alpha.id,
			purpose: "participant",
			actor: OWNER,
			now: T0 + 2,
		});
		if (!part.ok || !unread.ok || !part2.ok) return;

		const qToday = newId();
		await db.batch([
			insertMessage(db, {
				id: qToday,
				kind: "question",
				fromAgentId: alpha.id,
				toAgentId: beta.id,
				categoryId: cat.id,
				body: "q1",
				inReplyTo: null,
				status: "answered",
				createdAt: T0 + HOUR_MS,
				receivedAt: T0 + HOUR_MS,
				expiresAt: T0 + 7 * DAY_MS,
				bodyDeletedAt: null,
			}),
			insertMessage(db, {
				id: newId(),
				kind: "question",
				fromAgentId: alpha.id,
				toAgentId: null,
				categoryId: null,
				body: null,
				inReplyTo: null,
				status: "blocked",
				createdAt: T0 + DAY_MS - 1,
				receivedAt: null,
				expiresAt: null,
				bodyDeletedAt: null,
			}),
			// Yesterday's question and an answer by alpha must not count.
			insertMessage(db, {
				id: newId(),
				kind: "question",
				fromAgentId: alpha.id,
				toAgentId: beta.id,
				categoryId: cat.id,
				body: "yesterday",
				inReplyTo: null,
				status: "pending",
				createdAt: T0 - 1,
				receivedAt: null,
				expiresAt: T0 + 7 * DAY_MS,
				bodyDeletedAt: null,
			}),
			insertMessage(db, {
				id: newId(),
				kind: "answer",
				fromAgentId: alpha.id,
				toAgentId: beta.id,
				categoryId: cat.id,
				body: "reply",
				inReplyTo: qToday,
				status: "sent",
				createdAt: T0 + HOUR_MS,
				receivedAt: null,
				expiresAt: null,
				bodyDeletedAt: null,
			}),
		]);

		const list = await listAgentsWithStatus(db, T0 + 2 * HOUR_MS);
		expect(list.map((x) => x.agent.name)).toEqual(["alpha", "beta"]);
		expect(list[0]).toEqual({
			agent: alpha,
			todayQuestionCount: 2,
			activeTokens: {
				participant: {
					id: part2.data.tokenId,
					purpose: "participant",
					createdAt: T0 + 2,
				},
				admin: null,
				unread_count: {
					id: unread.data.tokenId,
					purpose: "unread_count",
					createdAt: T0 + 1,
				},
			},
		});
		expect(list[1]).toEqual({
			agent: beta,
			todayQuestionCount: 0,
			activeTokens: {
				participant: null,
				admin: null,
				unread_count: null,
			},
		});

		const serialized = JSON.stringify(list);
		expect(serialized).not.toContain("tokenHash");
		expect(serialized).not.toContain(part2.data.token);
		expect(serialized).not.toContain(unread.data.token);
	});

	it("listCategoriesWithUsage and listAllowRulesGrouped join names and counts", async () => {
		const muse: Agent = await seedAgent(db, {
			name: "muse",
			status: "suspended",
		});
		const grok: Agent = await seedAgent(db, { name: "grok" });
		const work: Category = await seedCategory(db, { name: "work" });
		const schedule: Category = await seedCategory(db, { name: "schedule" });
		const other: Category = await seedCategory(db, { name: "other" });

		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: work.id,
			actor: OWNER,
			now: T0,
		});
		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: OWNER,
			now: T0 + 1,
		});
		await grantAllowRule(db, {
			fromAgentId: grok.id,
			toAgentId: muse.id,
			categoryId: work.id,
			actor: OWNER,
			now: T0 + 2,
		});

		expect(await listCategoriesWithUsage(db)).toEqual([
			{ category: other, allowRuleCount: 0 },
			{ category: schedule, allowRuleCount: 1 },
			{ category: work, allowRuleCount: 2 },
		]);

		expect(await listAllowRulesGrouped(db)).toEqual([
			{
				fromAgentId: grok.id,
				fromAgentName: "grok",
				fromAgentStatus: "active",
				toAgentId: muse.id,
				toAgentName: "muse",
				toAgentStatus: "suspended",
				categories: [
					{ categoryId: work.id, categoryName: "work", createdAt: T0 + 2 },
				],
			},
			{
				fromAgentId: muse.id,
				fromAgentName: "muse",
				fromAgentStatus: "suspended",
				toAgentId: grok.id,
				toAgentName: "grok",
				toAgentStatus: "active",
				categories: [
					{
						categoryId: schedule.id,
						categoryName: "schedule",
						createdAt: T0 + 1,
					},
					{ categoryId: work.id, categoryName: "work", createdAt: T0 },
				],
			},
		]);
	});
});
