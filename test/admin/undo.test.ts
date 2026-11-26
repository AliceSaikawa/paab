import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	configureAgentWebhook,
	createCategory,
	deleteAgent,
	deleteAgentWebhook,
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
import { changedAgentFields } from "../../src/admin/undo";
import {
	listPendingDescriptions,
	reviewPendingDescription,
} from "../../src/adminbot/descriptions";
import { type AgentRow, agentFromRow } from "../../src/db";
import { checkQuestion } from "../../src/policy";
import type { ChangeLogEntry } from "../../src/types";
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

	it("reverts description_approved (non-empty and empty prior), blocks on newer description changes, and allows after webhook or limit changes", async () => {
		const grok = await seedAgent(db, {
			name: "grok",
			description: "v1 bio",
			dailyQuestionLimit: 20,
		});
		const muse = await seedAgent(db, {
			name: "muse",
			description: "",
			dailyQuestionLimit: 10,
		});

		await db
			.prepare(
				"INSERT INTO pending_descriptions (agent_id, description, submitted_at) VALUES (?, ?, ?)",
			)
			.bind(grok.id, "v2 bio", T0 + 1)
			.run();
		const approvedGrok = await reviewPendingDescription(db, {
			agentId: grok.id,
			action: "approve",
			actor: BOT,
			now: T0 + 2,
		});
		if (!approvedGrok.ok) throw new Error("approve grok failed");
		expect((await loadAgent(grok.id))?.description).toBe("v2 bio");

		// Unrelated webhook + daily limit mutations must NOT block description_approved undo.
		const webhookAdded = await configureAgentWebhook(db, {
			agentId: grok.id,
			url: "https://hooks.example.com/grok",
			actor: OWNER,
			now: T0 + 3,
		});
		if (!webhookAdded.ok) throw new Error("webhook configure failed");
		const limitChanged = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 12,
			actor: OWNER,
			now: T0 + 4,
		});
		if (!limitChanged.ok) throw new Error("limit update failed");
		const webhookDeleted = await deleteAgentWebhook(db, {
			agentId: grok.id,
			actor: OWNER,
			now: T0 + 5,
		});
		if (!webhookDeleted.ok) throw new Error("webhook delete failed");

		const revertedGrok = await revertAdminBotChange(db, {
			changeId: approvedGrok.changeId,
			actor: OWNER,
			now: T0 + 6,
		});
		expect(revertedGrok).toEqual({
			ok: true,
			data: {
				revertedChangeId: approvedGrok.changeId,
				action: "description_approved",
				targetType: "description",
				targetId: grok.id,
			},
			changeId: expect.any(Number),
		});
		const afterGrok = await loadAgent(grok.id);
		expect(afterGrok?.description).toBe("v1 bio");
		expect(afterGrok?.dailyQuestionLimit).toBe(12);

		expect(
			await revertAdminBotChange(db, {
				changeId: approvedGrok.changeId,
				actor: OWNER,
				now: T0 + 7,
			}),
		).toMatchObject({ ok: false, code: "already_reverted" });

		// Empty prior description restores cleanly to "".
		await db
			.prepare(
				"INSERT INTO pending_descriptions (agent_id, description, submitted_at) VALUES (?, ?, ?)",
			)
			.bind(muse.id, "muse first bio", T0 + 8)
			.run();
		const approvedMuse = await reviewPendingDescription(db, {
			agentId: muse.id,
			action: "approve",
			actor: BOT,
			now: T0 + 9,
		});
		if (!approvedMuse.ok) throw new Error("approve muse failed");
		const revertedMuse = await revertAdminBotChange(db, {
			changeId: approvedMuse.changeId,
			actor: OWNER,
			now: T0 + 10,
		});
		expect(revertedMuse.ok).toBe(true);
		expect((await loadAgent(muse.id))?.description).toBe("");

		// Newer description change (via updateAgent or description_approved) blocks undo.
		await db
			.prepare(
				"INSERT INTO pending_descriptions (agent_id, description, submitted_at) VALUES (?, ?, ?)",
			)
			.bind(grok.id, "v3 bio", T0 + 11)
			.run();
		const approvedV3 = await reviewPendingDescription(db, {
			agentId: grok.id,
			action: "approve",
			actor: BOT,
			now: T0 + 12,
		});
		if (!approvedV3.ok) throw new Error("approve v3 failed");

		await updateAgent(db, {
			agentId: grok.id,
			description: "owner edited bio",
			actor: OWNER,
			now: T0 + 13,
		});
		expect(
			await revertAdminBotChange(db, {
				changeId: approvedV3.changeId,
				actor: OWNER,
				now: T0 + 14,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
		expect((await loadAgent(grok.id))?.description).toBe("owner edited bio");

		// Newer description_approved also blocks undo of an earlier description_approved.
		await db
			.prepare(
				"INSERT INTO pending_descriptions (agent_id, description, submitted_at) VALUES (?, ?, ?)",
			)
			.bind(muse.id, "muse v2", T0 + 15)
			.run();
		const approvedMuseV2 = await reviewPendingDescription(db, {
			agentId: muse.id,
			action: "approve",
			actor: BOT,
			now: T0 + 16,
		});
		if (!approvedMuseV2.ok) throw new Error("approve muse v2 failed");
		await db
			.prepare(
				"INSERT INTO pending_descriptions (agent_id, description, submitted_at) VALUES (?, ?, ?)",
			)
			.bind(muse.id, "muse v3", T0 + 17)
			.run();
		const approvedMuseV3 = await reviewPendingDescription(db, {
			agentId: muse.id,
			action: "approve",
			actor: BOT,
			now: T0 + 18,
		});
		if (!approvedMuseV3.ok) throw new Error("approve muse v3 failed");

		expect(
			await revertAdminBotChange(db, {
				changeId: approvedMuseV2.changeId,
				actor: OWNER,
				now: T0 + 19,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
	});

	it("reverts description_rejected back into pending_descriptions with submittedAt and blocks if new draft or review exists", async () => {
		const grok = await seedAgent(db, {
			name: "grok",
			description: "approved bio",
			dailyQuestionLimit: 20,
		});
		const submittedAt = T0 + 100;

		await db
			.prepare(
				"INSERT INTO pending_descriptions (agent_id, description, submitted_at) VALUES (?, ?, ?)",
			)
			.bind(grok.id, "draft bio v1", submittedAt)
			.run();

		const rejected = await reviewPendingDescription(db, {
			agentId: grok.id,
			action: "reject",
			actor: BOT,
			now: T0 + 200,
		});
		if (!rejected.ok) throw new Error("reject failed");
		expect(await listPendingDescriptions(db)).toEqual([]);

		// Webhook/limit changes do not block undoing description_rejected.
		await configureAgentWebhook(db, {
			agentId: grok.id,
			url: "https://hooks.example.com/grok",
			actor: OWNER,
			now: T0 + 210,
		});
		await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 15,
			actor: OWNER,
			now: T0 + 220,
		});

		const reverted = await revertAdminBotChange(db, {
			changeId: rejected.changeId,
			actor: OWNER,
			now: T0 + 300,
		});
		expect(reverted).toEqual({
			ok: true,
			data: {
				revertedChangeId: rejected.changeId,
				action: "description_rejected",
				targetType: "description",
				targetId: grok.id,
			},
			changeId: expect.any(Number),
		});

		const pending = await listPendingDescriptions(db);
		expect(pending).toEqual([
			{
				agentId: grok.id,
				agentName: "grok",
				agentStatus: "active",
				currentDescription: "approved bio",
				pendingDescription: "draft bio v1",
				submittedAt,
			},
		]);

		// Reject again, then submit a new draft -> undo must return conflict_newer_change.
		const rejectedAgain = await reviewPendingDescription(db, {
			agentId: grok.id,
			action: "reject",
			actor: BOT,
			now: T0 + 400,
		});
		if (!rejectedAgain.ok) throw new Error("second reject failed");

		await db
			.prepare(
				"INSERT INTO pending_descriptions (agent_id, description, submitted_at) VALUES (?, ?, ?)",
			)
			.bind(grok.id, "newer draft bio v2", T0 + 500)
			.run();

		expect(
			await revertAdminBotChange(db, {
				changeId: rejectedAgain.changeId,
				actor: OWNER,
				now: T0 + 600,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });

		// Even after the newer draft is approved (clearing pending_descriptions),
		// undoing the earlier rejection must still fail with conflict_newer_change.
		const approvedNewer = await reviewPendingDescription(db, {
			agentId: grok.id,
			action: "approve",
			actor: BOT,
			now: T0 + 700,
		});
		if (!approvedNewer.ok) throw new Error("approve newer failed");
		expect(await listPendingDescriptions(db)).toEqual([]);

		expect(
			await revertAdminBotChange(db, {
				changeId: rejectedAgain.changeId,
				actor: OWNER,
				now: T0 + 800,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
	});

	it("allows undoing agent_suspended and agent_updated (daily limit) after configureAgentWebhook and deleteAgentWebhook", async () => {
		const grok = await seedAgent(db, {
			name: "grok",
			description: "grok bio",
			dailyQuestionLimit: 20,
			status: "active",
		});

		const lowered = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 5,
			actor: BOT,
			now: T0 + 1,
		});
		if (!lowered.ok || lowered.changeId === null) {
			throw new Error("lower failed");
		}
		const suspended = await suspendAgent(db, {
			agentId: grok.id,
			actor: BOT,
			now: T0 + 2,
		});
		if (!suspended.ok) throw new Error("suspend failed");

		const configured = await configureAgentWebhook(db, {
			agentId: grok.id,
			url: "https://hooks.example.com/wake",
			actor: OWNER,
			now: T0 + 3,
		});
		if (!configured.ok) throw new Error("configureAgentWebhook failed");

		const deleted = await deleteAgentWebhook(db, {
			agentId: grok.id,
			actor: OWNER,
			now: T0 + 4,
		});
		if (!deleted.ok) throw new Error("deleteAgentWebhook failed");

		expect(
			await revertAdminBotChange(db, {
				changeId: suspended.changeId,
				actor: OWNER,
				now: T0 + 5,
			}),
		).toMatchObject({ ok: true });
		expect((await loadAgent(grok.id))?.status).toBe("active");

		expect(
			await revertAdminBotChange(db, {
				changeId: lowered.changeId,
				actor: OWNER,
				now: T0 + 6,
			}),
		).toMatchObject({ ok: true });
		expect((await loadAgent(grok.id))?.dailyQuestionLimit).toBe(20);
	});

	it("reverts lower_daily_limit after description_approved without clobbering the newly approved description, and still checks duplicate_name when restoring name", async () => {
		const grok = await seedAgent(db, {
			name: "grok",
			description: "v1 bio",
			dailyQuestionLimit: 20,
		});

		const lowered = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 4,
			actor: BOT,
			now: T0 + 1,
		});
		if (!lowered.ok || lowered.changeId === null) {
			throw new Error("lower failed");
		}

		await db
			.prepare(
				"INSERT INTO pending_descriptions (agent_id, description, submitted_at) VALUES (?, ?, ?)",
			)
			.bind(grok.id, "v2 approved bio", T0 + 2)
			.run();
		const approved = await reviewPendingDescription(db, {
			agentId: grok.id,
			action: "approve",
			actor: BOT,
			now: T0 + 3,
		});
		if (!approved.ok) throw new Error("approve failed");

		// Owner also renames grok; undoing dailyQuestionLimit must keep both new name and new description.
		await updateAgent(db, {
			agentId: grok.id,
			name: "grok-renamed",
			actor: OWNER,
			now: T0 + 4,
		});

		const revertedLower = await revertAdminBotChange(db, {
			changeId: lowered.changeId,
			actor: OWNER,
			now: T0 + 5,
		});
		expect(revertedLower.ok).toBe(true);

		const after = await loadAgent(grok.id);
		expect(after?.dailyQuestionLimit).toBe(20);
		expect(after?.description).toBe("v2 approved bio");
		expect(after?.name).toBe("grok-renamed");

		// Conversely, undoing an agent_updated that modified description MUST conflict with a newer description_approved.
		const descUpdate = await updateAgent(db, {
			agentId: grok.id,
			description: "bot manual bio",
			actor: BOT,
			now: T0 + 6,
		});
		if (!descUpdate.ok || descUpdate.changeId === null) {
			throw new Error("desc update failed");
		}
		await db
			.prepare(
				"INSERT INTO pending_descriptions (agent_id, description, submitted_at) VALUES (?, ?, ?)",
			)
			.bind(grok.id, "v3 approved bio", T0 + 7)
			.run();
		const approvedV3 = await reviewPendingDescription(db, {
			agentId: grok.id,
			action: "approve",
			actor: BOT,
			now: T0 + 8,
		});
		if (!approvedV3.ok) throw new Error("approve v3 failed");

		expect(
			await revertAdminBotChange(db, {
				changeId: descUpdate.changeId,
				actor: OWNER,
				now: T0 + 9,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });

		// Duplicate-name check still applies when "name" is in fieldsToRestore.
		const renamedByBot = await updateAgent(db, {
			agentId: grok.id,
			name: "grok-temp",
			actor: BOT,
			now: T0 + 10,
		});
		if (!renamedByBot.ok || renamedByBot.changeId === null) {
			throw new Error("bot rename failed");
		}
		await seedAgent(db, { name: "grok-renamed" });
		expect(
			await revertAdminBotChange(db, {
				changeId: renamedByBot.changeId,
				actor: OWNER,
				now: T0 + 11,
			}),
		).toMatchObject({ ok: false, code: "duplicate_name" });
	});

	it("reverts category_created after owner manually revokes an allow rule on that category, while blocking while the rule exists", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const grok = await seedAgent(db, { name: "grok" });

		const created = await createCategory(db, {
			name: "finance",
			actor: BOT,
			now: T0 + 1,
		});
		if (!created.ok) throw new Error("createCategory failed");

		const granted = await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: created.data.category.id,
			actor: OWNER,
			now: T0 + 2,
		});
		if (!granted.ok) throw new Error("grant failed");

		expect(
			await revertAdminBotChange(db, {
				changeId: created.changeId,
				actor: OWNER,
				now: T0 + 3,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });

		// Owner manually revokes the allow rule (leaving un-reverted allow_rule rows in change_log).
		const revoked = await revokeAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: created.data.category.id,
			actor: OWNER,
			now: T0 + 4,
		});
		if (!revoked.ok) throw new Error("revoke failed");

		const reverted = await revertAdminBotChange(db, {
			changeId: created.changeId,
			actor: OWNER,
			now: T0 + 5,
		});
		expect(reverted.ok).toBe(true);

		const row = await db
			.prepare("SELECT id FROM categories WHERE id = ?")
			.bind(created.data.category.id)
			.first();
		expect(row).toBeNull();
	});
});

describe("changedAgentFields", () => {
	function makeEntry(
		partial: Partial<ChangeLogEntry> & Pick<ChangeLogEntry, "action">,
	): ChangeLogEntry {
		return {
			id: 1,
			occurredAt: T0,
			actorType: "admin_bot",
			actorId: "bot-1",
			approverId: null,
			targetType: "agent",
			targetId: "agent-1",
			beforeJson: null,
			afterJson: null,
			revertedAt: null,
			...partial,
		};
	}

	it("classifies status, deleted, description, updated, and non-mutating actions accurately", () => {
		expect([
			...changedAgentFields(makeEntry({ action: "agent_suspended" })),
		]).toEqual(["status"]);
		expect([
			...changedAgentFields(makeEntry({ action: "agent_resumed" })),
		]).toEqual(["status"]);
		expect([
			...changedAgentFields(makeEntry({ action: "agent_deleted" })),
		]).toEqual(["status", "name", "description", "dailyQuestionLimit"]);
		expect([
			...changedAgentFields(
				makeEntry({
					action: "description_approved",
					targetType: "description",
				}),
			),
		]).toEqual(["description"]);

		expect([
			...changedAgentFields(
				makeEntry({
					action: "agent_updated",
					beforeJson: JSON.stringify({
						name: "grok",
						description: "v1",
						dailyQuestionLimit: 20,
					}),
					afterJson: JSON.stringify({
						name: "grok",
						description: "v1",
						dailyQuestionLimit: 5,
					}),
				}),
			),
		]).toEqual(["dailyQuestionLimit"]);

		// Null or unparseable afterJson conservatively treats all present snapshot fields as changed.
		expect([
			...changedAgentFields(
				makeEntry({
					action: "agent_updated",
					beforeJson: JSON.stringify({
						description: "v1",
						dailyQuestionLimit: 20,
					}),
					afterJson: null,
				}),
			),
		]).toEqual(["description", "dailyQuestionLimit"]);
		expect([
			...changedAgentFields(
				makeEntry({
					action: "agent_updated",
					beforeJson: JSON.stringify({
						name: "grok",
						description: "v1",
						dailyQuestionLimit: 20,
					}),
					afterJson: "{not-json",
				}),
			),
		]).toEqual(["name", "description", "dailyQuestionLimit"]);

		for (const action of [
			"webhook_configured",
			"webhook_deleted",
			"agent_registered",
			"description_rejected",
		] as const) {
			expect([...changedAgentFields(makeEntry({ action }))]).toEqual([]);
		}
	});
});
