import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	createCategory,
	deleteAgent,
	deleteCategory,
	grantAllowRule,
	listAdminBotChanges,
	queryChangeLog,
	registerAgent,
	resumeAgent,
	revertAdminBotChange,
	revokeAllowRule,
	suspendAgent,
	updateAgent,
} from "../../src/admin";
import { type AgentRow, agentFromRow } from "../../src/db";
import { checkQuestion } from "../../src/policy";
import { createTestDb } from "../helpers/db";
import { seedAgent, seedCategory, T0 } from "../helpers/fixtures";

const OWNER: ChangeActor = { actorType: "owner", actorId: "owner@example.com" };
const BOT: ChangeActor = { actorType: "admin_bot", actorId: "admin-bot-1" };

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
});

async function loadAgent(id: string) {
	const row = await db
		.prepare("SELECT * FROM agents WHERE id = ?")
		.bind(id)
		.first<AgentRow>();
	return row ? agentFromRow(row) : null;
}

describe("listAdminBotChanges", () => {
	it("returns only admin_bot change_log rows, newest first, honoring limit", async () => {
		const a = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 20,
			actor: OWNER,
			now: T0,
		});
		if (!a.ok) throw new Error("register failed");
		const c1 = await updateAgent(db, {
			agentId: a.data.agent.id,
			dailyQuestionLimit: 15,
			actor: BOT,
			now: T0 + 10,
		});
		const c2 = await suspendAgent(db, {
			agentId: a.data.agent.id,
			actor: BOT,
			now: T0 + 20,
		});
		await resumeAgent(db, {
			agentId: a.data.agent.id,
			actor: OWNER,
			now: T0 + 30,
		});
		if (!c1.ok || !c2.ok) throw new Error("mutations failed");

		const botChanges = await listAdminBotChanges(db);
		expect(botChanges.map((entry) => entry.id)).toEqual([
			c2.changeId,
			c1.changeId,
		]);
		expect(botChanges.every((entry) => entry.actorType === "admin_bot")).toBe(
			true,
		);

		const limited = await listAdminBotChanges(db, 1);
		expect(limited.map((entry) => entry.id)).toEqual([c2.changeId]);
	});
});

describe("revertAdminBotChange", () => {
	it("reverts agent_suspended and agent_resumed atomically and logs change_reverted", async () => {
		const grok = await seedAgent(db, { name: "grok", status: "active" });

		const suspended = await suspendAgent(db, {
			agentId: grok.id,
			actor: BOT,
			now: T0 + 1,
		});
		if (!suspended.ok) throw new Error("suspend failed");

		const revertedSuspend = await revertAdminBotChange(db, {
			changeId: suspended.changeId,
			actor: OWNER,
			now: T0 + 2,
		});
		expect(revertedSuspend).toEqual({
			ok: true,
			data: {
				revertedChangeId: suspended.changeId,
				action: "agent_suspended",
				targetType: "agent",
				targetId: grok.id,
			},
			changeId: expect.any(Number),
		});
		if (!revertedSuspend.ok) return;

		expect((await loadAgent(grok.id))?.status).toBe("active");

		const logs = await queryChangeLog(db);
		const original = logs.find((e) => e.id === suspended.changeId);
		const revertEntry = logs.find((e) => e.id === revertedSuspend.changeId);
		expect(original?.revertedAt).toBe(T0 + 2);
		expect(revertEntry).toEqual({
			id: revertedSuspend.changeId,
			occurredAt: T0 + 2,
			actorType: "owner",
			actorId: OWNER.actorId,
			approverId: null,
			action: "change_reverted",
			targetType: "agent",
			targetId: grok.id,
			beforeJson: original?.afterJson ?? null,
			afterJson: original?.beforeJson ?? null,
			revertedAt: null,
		});

		await suspendAgent(db, { agentId: grok.id, actor: OWNER, now: T0 + 3 });
		const resumed = await resumeAgent(db, {
			agentId: grok.id,
			actor: BOT,
			now: T0 + 4,
		});
		if (!resumed.ok) throw new Error("resume failed");

		const revertedResume = await revertAdminBotChange(db, {
			changeId: resumed.changeId,
			actor: OWNER,
			now: T0 + 5,
		});
		expect(revertedResume.ok).toBe(true);
		expect((await loadAgent(grok.id))?.status).toBe("suspended");
	});

	it("reverts agent_updated (limit, description, name) and handles double-undo", async () => {
		const grok = await seedAgent(db, {
			name: "grok",
			description: "original desc",
			dailyQuestionLimit: 25,
		});

		const updated = await updateAgent(db, {
			agentId: grok.id,
			description: "changed desc",
			dailyQuestionLimit: 5,
			actor: BOT,
			now: T0 + 1,
		});
		if (!updated.ok || updated.changeId === null) {
			throw new Error("update failed");
		}

		const reverted = await revertAdminBotChange(db, {
			changeId: updated.changeId,
			actor: OWNER,
			now: T0 + 2,
		});
		expect(reverted.ok).toBe(true);

		const after = await loadAgent(grok.id);
		expect(after?.dailyQuestionLimit).toBe(25);
		expect(after?.description).toBe("original desc");

		const secondUndo = await revertAdminBotChange(db, {
			changeId: updated.changeId,
			actor: OWNER,
			now: T0 + 3,
		});
		expect(secondUndo).toMatchObject({ ok: false, code: "already_reverted" });
	});

	it("reverts allow_rule_revoked and allow_rule_granted", async () => {
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

		const revoked = await revokeAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: BOT,
			now: T0 + 1,
		});
		if (!revoked.ok) throw new Error("revoke failed");

		expect(
			(
				await checkQuestion(db, {
					fromAgentId: muse.id,
					toAgentName: "grok",
					categoryName: "schedule",
					now: T0 + 2,
				})
			).allowed,
		).toBe(false);

		const restored = await revertAdminBotChange(db, {
			changeId: revoked.changeId,
			actor: OWNER,
			now: T0 + 3,
		});
		expect(restored.ok).toBe(true);
		expect(
			(
				await checkQuestion(db, {
					fromAgentId: muse.id,
					toAgentName: "grok",
					categoryName: "schedule",
					now: T0 + 4,
				})
			).allowed,
		).toBe(true);

		const granted = await grantAllowRule(db, {
			fromAgentId: grok.id,
			toAgentId: muse.id,
			categoryId: schedule.id,
			actor: BOT,
			now: T0 + 5,
		});
		if (!granted.ok) throw new Error("grant failed");

		const undoneGrant = await revertAdminBotChange(db, {
			changeId: granted.changeId,
			actor: OWNER,
			now: T0 + 6,
		});
		expect(undoneGrant.ok).toBe(true);
		expect(
			(
				await checkQuestion(db, {
					fromAgentId: grok.id,
					toAgentName: "muse",
					categoryName: "schedule",
					now: T0 + 7,
				})
			).allowed,
		).toBe(false);
	});

	it("reverts category_created and blocks if allow_rule still depends on it", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const grok = await seedAgent(db, { name: "grok" });

		const created = await createCategory(db, {
			name: "travel",
			actor: BOT,
			now: T0 + 1,
		});
		if (!created.ok) throw new Error("createCategory failed");

		const granted = await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: created.data.category.id,
			actor: BOT,
			now: T0 + 2,
		});
		if (!granted.ok) throw new Error("grant failed");

		const blocked = await revertAdminBotChange(db, {
			changeId: created.changeId,
			actor: OWNER,
			now: T0 + 3,
		});
		expect(blocked).toMatchObject({
			ok: false,
			code: "conflict_newer_change",
		});

		const undoneGrant = await revertAdminBotChange(db, {
			changeId: granted.changeId,
			actor: OWNER,
			now: T0 + 4,
		});
		expect(undoneGrant.ok).toBe(true);

		const undoneCat = await revertAdminBotChange(db, {
			changeId: created.changeId,
			actor: OWNER,
			now: T0 + 5,
		});
		expect(undoneCat.ok).toBe(true);

		const row = await db
			.prepare("SELECT id FROM categories WHERE id = ?")
			.bind(created.data.category.id)
			.first();
		expect(row).toBeNull();
	});

	it("enforces conflict_newer_change for same target and deleted allow_rule dependencies, while allowing LIFO rollback", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const grok = await seedAgent(db, {
			name: "grok",
			dailyQuestionLimit: 20,
		});
		const schedule = await seedCategory(db, { name: "schedule" });

		const botLower1 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 10,
			actor: BOT,
			now: T0 + 1,
		});
		const botLower2 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 5,
			actor: BOT,
			now: T0 + 2,
		});
		if (
			!botLower1.ok ||
			botLower1.changeId === null ||
			!botLower2.ok ||
			botLower2.changeId === null
		) {
			throw new Error("updates failed");
		}

		expect(
			await revertAdminBotChange(db, {
				changeId: botLower1.changeId,
				actor: OWNER,
				now: T0 + 3,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });

		// Reverting newest first unblocks the earlier change even though change_reverted was logged.
		expect(
			await revertAdminBotChange(db, {
				changeId: botLower2.changeId,
				actor: OWNER,
				now: T0 + 4,
			}),
		).toMatchObject({ ok: true });
		expect((await loadAgent(grok.id))?.dailyQuestionLimit).toBe(10);

		expect(
			await revertAdminBotChange(db, {
				changeId: botLower1.changeId,
				actor: OWNER,
				now: T0 + 5,
			}),
		).toMatchObject({ ok: true });
		expect((await loadAgent(grok.id))?.dailyQuestionLimit).toBe(20);

		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: OWNER,
			now: T0 + 6,
		});
		const botRevoke = await revokeAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: BOT,
			now: T0 + 7,
		});
		if (!botRevoke.ok) throw new Error("revoke failed");

		await deleteAgent(db, {
			agentId: grok.id,
			actor: OWNER,
			now: T0 + 8,
		});
		expect(
			await revertAdminBotChange(db, {
				changeId: botRevoke.changeId,
				actor: OWNER,
				now: T0 + 9,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });

		const alice = await seedAgent(db, { name: "alice" });
		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: alice.id,
			categoryId: schedule.id,
			actor: OWNER,
			now: T0 + 10,
		});
		const botRevoke2 = await revokeAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: alice.id,
			categoryId: schedule.id,
			actor: BOT,
			now: T0 + 11,
		});
		if (!botRevoke2.ok) throw new Error("revoke2 failed");
		await deleteCategory(db, {
			categoryId: schedule.id,
			actor: OWNER,
			now: T0 + 12,
		});
		expect(
			await revertAdminBotChange(db, {
				changeId: botRevoke2.changeId,
				actor: OWNER,
				now: T0 + 13,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
	});

	it("rejects missing, owner, non-undoable, non-owner actor, and missing-target entries", async () => {
		expect(
			await revertAdminBotChange(db, {
				changeId: 999999,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "not_found" });

		expect(
			await revertAdminBotChange(db, {
				changeId: 0,
				actor: OWNER,
				now: T0,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });

		const regOwner = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 10,
			actor: OWNER,
			now: T0,
		});
		if (!regOwner.ok) throw new Error("register failed");

		expect(
			await revertAdminBotChange(db, {
				changeId: regOwner.changeId,
				actor: OWNER,
				now: T0 + 1,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });

		const regBot = await registerAgent(db, {
			name: "non-undoable-target",
			dailyQuestionLimit: 10,
			actor: BOT,
			now: T0 + 2,
		});
		if (!regBot.ok) throw new Error("register failed");

		expect(
			await revertAdminBotChange(db, {
				changeId: regBot.changeId,
				actor: BOT,
				now: T0 + 3,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });

		expect(
			await revertAdminBotChange(db, {
				changeId: regBot.changeId,
				actor: OWNER,
				now: T0 + 4,
			}),
		).toMatchObject({ ok: false, code: "not_undoable" });

		const susp = await suspendAgent(db, {
			agentId: regOwner.data.agent.id,
			actor: BOT,
			now: T0 + 5,
		});
		if (!susp.ok) throw new Error("suspend failed");

		// Simulate missing agent row without change_log entry.
		await db
			.prepare("DELETE FROM agents WHERE id = ?")
			.bind(regOwner.data.agent.id)
			.run();
		expect(
			await revertAdminBotChange(db, {
				changeId: susp.changeId,
				actor: OWNER,
				now: T0 + 6,
			}),
		).toMatchObject({ ok: false, code: "not_found" });

		expect(
			await revertAdminBotChange(db, {
				changeId: -1,
				actor: OWNER,
				now: T0 + 7,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });
	});
});
