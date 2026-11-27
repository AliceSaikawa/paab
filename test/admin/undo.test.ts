import { beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeActor,
	createCategory,
	deleteAgent,
	deleteCategory,
	grantAllowRule,
	inspectAdminBotChangesUndoState,
	listAdminBotChanges,
	queryChangeLog,
	registerAgent,
	resumeAgent,
	revertAdminBotChange,
	revokeAllowRule,
	suspendAgent,
	updateAgent,
} from "../../src/admin";
import {
	approvePendingDescription,
	listPendingDescriptions,
	rejectPendingDescription,
	submitPendingDescription,
} from "../../src/adminbot";
import {
	type AgentRow,
	agentFromRow,
	insertChangeLogEntry,
	type PendingDescriptionRow,
	pendingDescriptionFromRow,
} from "../../src/db";
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

async function loadPendingDescription(agentId: string) {
	const row = await db
		.prepare("SELECT * FROM pending_descriptions WHERE agent_id = ?")
		.bind(agentId)
		.first<PendingDescriptionRow>();
	return row ? pendingDescriptionFromRow(row) : null;
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

	it("reverts description_approved without clobbering unrelated agent fields and detects newer description conflicts", async () => {
		const grok = await seedAgent(db, {
			name: "grok",
			description: "original bio",
			dailyQuestionLimit: 20,
			status: "active",
		});

		const sub1 = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "approved bio v1",
			now: T0 + 1,
		});
		if (!sub1.ok) throw new Error("submit 1 failed");
		const approved1 = await approvePendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: sub1.data.pending.submissionId,
			actor: BOT,
			now: T0 + 2,
		});
		if (!approved1.ok) throw new Error("approve 1 failed");
		expect((await loadAgent(grok.id))?.description).toBe("approved bio v1");

		// Unrelated mutations (suspend + daily limit change + rejected draft) must not block reverting description_approved.
		await suspendAgent(db, { agentId: grok.id, actor: OWNER, now: T0 + 3 });
		await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 7,
			actor: OWNER,
			now: T0 + 4,
		});
		const subReject = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "rejected draft",
			now: T0 + 5,
		});
		if (!subReject.ok) throw new Error("submit reject failed");
		const rejected = await rejectPendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: subReject.data.pending.submissionId,
			actor: BOT,
			now: T0 + 6,
		});
		if (!rejected.ok) throw new Error("reject failed");

		// Reverting description_approved restores ONLY description and preserves status + dailyQuestionLimit.
		const reverted1 = await revertAdminBotChange(db, {
			changeId: approved1.changeId,
			actor: OWNER,
			now: T0 + 8,
		});
		expect(reverted1).toEqual({
			ok: true,
			data: {
				revertedChangeId: approved1.changeId,
				action: "description_approved",
				targetType: "description",
				targetId: grok.id,
			},
			changeId: expect.any(Number),
		});
		const afterRevert1 = await loadAgent(grok.id);
		expect(afterRevert1).toMatchObject({
			description: "original bio",
			status: "suspended",
			dailyQuestionLimit: 7,
		});

		// Double-undo is rejected.
		expect(
			await revertAdminBotChange(db, {
				changeId: approved1.changeId,
				actor: OWNER,
				now: T0 + 9,
			}),
		).toMatchObject({ ok: false, code: "already_reverted" });

		// A newer description_approved blocks reverting an earlier description_approved until undone newest-first.
		const sub2 = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "approved bio v2",
			now: T0 + 10,
		});
		if (!sub2.ok) throw new Error("submit 2 failed");
		const approved2 = await approvePendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: sub2.data.pending.submissionId,
			actor: BOT,
			now: T0 + 11,
		});
		const sub3 = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "approved bio v3",
			now: T0 + 12,
		});
		if (!sub3.ok) throw new Error("submit 3 failed");
		const approved3 = await approvePendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: sub3.data.pending.submissionId,
			actor: BOT,
			now: T0 + 13,
		});
		if (!approved2.ok || !approved3.ok) throw new Error("approves failed");

		expect(
			await revertAdminBotChange(db, {
				changeId: approved2.changeId,
				actor: OWNER,
				now: T0 + 14,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });

		expect(
			await revertAdminBotChange(db, {
				changeId: approved3.changeId,
				actor: OWNER,
				now: T0 + 15,
			}),
		).toMatchObject({ ok: true });
		expect((await loadAgent(grok.id))?.description).toBe("approved bio v2");

		expect(
			await revertAdminBotChange(db, {
				changeId: approved2.changeId,
				actor: OWNER,
				now: T0 + 16,
			}),
		).toMatchObject({ ok: true });
		expect((await loadAgent(grok.id))?.description).toBe("original bio");
	});

	it("reverts description_rejected back into pending_descriptions and refuses when a newer submission exists or the agent was deleted", async () => {
		const grok = await seedAgent(db, {
			name: "grok",
			description: "original bio",
		});

		const sub = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "candidate bio to restore",
			now: T0 + 1,
		});
		if (!sub.ok) throw new Error("submit failed");
		const rejected = await rejectPendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: sub.data.pending.submissionId,
			actor: BOT,
			now: T0 + 2,
		});
		if (!rejected.ok) throw new Error("reject failed");
		expect(await loadPendingDescription(grok.id)).toBeNull();

		// Unrelated agent changes must not block reverting description_rejected.
		await suspendAgent(db, { agentId: grok.id, actor: OWNER, now: T0 + 3 });

		const restored = await revertAdminBotChange(db, {
			changeId: rejected.changeId,
			actor: OWNER,
			now: T0 + 4,
		});
		expect(restored).toEqual({
			ok: true,
			data: {
				revertedChangeId: rejected.changeId,
				action: "description_rejected",
				targetType: "description",
				targetId: grok.id,
			},
			changeId: expect.any(Number),
		});
		expect(await loadPendingDescription(grok.id)).toEqual({
			agentId: grok.id,
			submissionId: sub.data.pending.submissionId,
			description: "candidate bio to restore",
			submittedAt: T0 + 1,
		});
		expect((await loadAgent(grok.id))?.description).toBe("original bio");
		expect(
			(await listPendingDescriptions(db)).map((p) => p.pendingDescription),
		).toEqual(["candidate bio to restore"]);

		// Double-undo is rejected.
		expect(
			await revertAdminBotChange(db, {
				changeId: rejected.changeId,
				actor: OWNER,
				now: T0 + 5,
			}),
		).toMatchObject({ ok: false, code: "already_reverted" });

		// Reject again, then submit a newer draft: undo must fail with conflict_newer_change and preserve the new draft.
		const rejected2 = await rejectPendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: sub.data.pending.submissionId,
			actor: BOT,
			now: T0 + 6,
		});
		if (!rejected2.ok) throw new Error("reject 2 failed");
		const newerSub = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "freshly submitted draft",
			now: T0 + 7,
		});
		if (!newerSub.ok) throw new Error("newer submit failed");

		expect(
			await revertAdminBotChange(db, {
				changeId: rejected2.changeId,
				actor: OWNER,
				now: T0 + 8,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
		expect((await loadPendingDescription(grok.id))?.description).toBe(
			"freshly submitted draft",
		);

		// Legacy snapshot (without submissionId / submittedAt) still restores cleanly.
		const alice = await seedAgent(db, { name: "alice" });
		const legacyInsert = await insertChangeLogEntry(db, {
			occurredAt: T0 + 10,
			actorType: "admin_bot",
			actorId: BOT.actorId,
			approverId: null,
			action: "description_rejected",
			targetType: "description",
			targetId: alice.id,
			beforeJson: JSON.stringify({
				agentId: alice.id,
				name: "alice",
				description: "legacy rejected draft",
			}),
			afterJson: null,
			revertedAt: null,
		}).run();
		const legacyChangeId = Number(legacyInsert.meta.last_row_id);
		const legacyRestore = await revertAdminBotChange(db, {
			changeId: legacyChangeId,
			actor: OWNER,
			now: T0 + 11,
		});
		expect(legacyRestore.ok).toBe(true);
		expect(await loadPendingDescription(alice.id)).toMatchObject({
			agentId: alice.id,
			description: "legacy rejected draft",
			submittedAt: T0 + 10,
		});

		// Deleted agent fails cleanly with not_found.
		const bob = await seedAgent(db, { name: "bob" });
		const bobSub = await submitPendingDescription(db, {
			agentId: bob.id,
			description: "bob draft",
			now: T0 + 12,
		});
		if (!bobSub.ok) throw new Error("bob submit failed");
		const bobRejected = await rejectPendingDescription(db, {
			agentId: bob.id,
			expectedSubmissionId: bobSub.data.pending.submissionId,
			actor: BOT,
			now: T0 + 13,
		});
		if (!bobRejected.ok) throw new Error("bob reject failed");
		await deleteAgent(db, { agentId: bob.id, actor: OWNER, now: T0 + 14 });
		expect(
			await revertAdminBotChange(db, {
				changeId: bobRejected.changeId,
				actor: OWNER,
				now: T0 + 15,
			}),
		).toMatchObject({ ok: false, code: "not_found" });
	});

	it("supports 1-operation cascade undo for stacked admin_bot changes while refusing when an owner change intervened", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const grok = await seedAgent(db, {
			name: "grok",
			dailyQuestionLimit: 20,
			status: "active",
		});

		const c1 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 15,
			actor: BOT,
			now: T0 + 1,
		});
		// Unrelated owner change on a different field (status) must NOT block limit cascade.
		await suspendAgent(db, { agentId: grok.id, actor: OWNER, now: T0 + 2 });
		const c2 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 10,
			actor: BOT,
			now: T0 + 3,
		});
		const c3 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 5,
			actor: BOT,
			now: T0 + 4,
		});
		if (
			!c1.ok ||
			c1.changeId === null ||
			!c2.ok ||
			c2.changeId === null ||
			!c3.ok ||
			c3.changeId === null
		) {
			throw new Error("stacked updates failed");
		}

		const botEntries = await listAdminBotChanges(db);
		const availability = await inspectAdminBotChangesUndoState(db, botEntries);
		expect(availability.get(c3.changeId)).toEqual({ kind: "ready" });
		expect(availability.get(c2.changeId)).toEqual({
			kind: "cascade",
			count: 2,
			blockerIds: [c3.changeId],
		});
		expect(availability.get(c1.changeId)).toEqual({
			kind: "cascade",
			count: 3,
			blockerIds: [c2.changeId, c3.changeId],
		});

		// Default single undo still returns conflict_newer_change.
		expect(
			await revertAdminBotChange(db, {
				changeId: c1.changeId,
				actor: OWNER,
				now: T0 + 5,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });

		// Cascade undo reverts c3, c2, c1 in one operation and keeps owner's suspension intact.
		const cascaded = await revertAdminBotChange(db, {
			changeId: c1.changeId,
			actor: OWNER,
			now: T0 + 6,
			cascade: true,
		});
		expect(cascaded).toEqual({
			ok: true,
			data: {
				revertedChangeId: c1.changeId,
				action: "agent_updated",
				targetType: "agent",
				targetId: grok.id,
				revertedChangeIds: [c3.changeId, c2.changeId, c1.changeId],
			},
			changeId: expect.any(Number),
		});
		expect(await loadAgent(grok.id)).toMatchObject({
			dailyQuestionLimit: 20,
			status: "suspended",
		});

		const logsAfterCascade = await queryChangeLog(db);
		for (const id of [c1.changeId, c2.changeId, c3.changeId]) {
			expect(logsAfterCascade.find((e) => e.id === id)?.revertedAt).toBe(
				T0 + 6,
			);
		}
		expect(
			logsAfterCascade.filter((e) => e.action === "change_reverted"),
		).toHaveLength(3);

		// Owner intervening on the SAME field blocks even cascade undo.
		const b1 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 12,
			actor: BOT,
			now: T0 + 10,
		});
		await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 30,
			actor: OWNER,
			now: T0 + 11,
		});
		const b2 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 8,
			actor: BOT,
			now: T0 + 12,
		});
		if (!b1.ok || b1.changeId === null || !b2.ok || b2.changeId === null) {
			throw new Error("owner-intervened updates failed");
		}
		const afterOwner = await inspectAdminBotChangesUndoState(
			db,
			await listAdminBotChanges(db),
		);
		expect(afterOwner.get(b1.changeId)?.kind).toBe("blocked");
		expect(
			await revertAdminBotChange(db, {
				changeId: b1.changeId,
				actor: OWNER,
				now: T0 + 13,
				cascade: true,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
		expect((await loadAgent(grok.id))?.dailyQuestionLimit).toBe(8);

		// Cascade undo for category_created + admin_bot allow_rule_granted.
		const cat = await createCategory(db, {
			name: "travel",
			actor: BOT,
			now: T0 + 20,
		});
		if (!cat.ok) throw new Error("createCategory failed");
		const rule = await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: cat.data.category.id,
			actor: BOT,
			now: T0 + 21,
		});
		if (!rule.ok) throw new Error("grant failed");

		const catCascade = await revertAdminBotChange(db, {
			changeId: cat.changeId,
			actor: OWNER,
			now: T0 + 22,
			cascade: true,
		});
		expect(catCascade).toMatchObject({
			ok: true,
			data: {
				revertedChangeId: cat.changeId,
				revertedChangeIds: [rule.changeId, cat.changeId],
			},
		});
		expect(
			await db
				.prepare("SELECT id FROM categories WHERE id = ?")
				.bind(cat.data.category.id)
				.first(),
		).toBeNull();

		// Cascade undo for allow_rule grant -> revoke (net no-op on allow_rules).
		const work = await seedCategory(db, { name: "work" });
		const g1 = await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: work.id,
			actor: BOT,
			now: T0 + 30,
		});
		const r1 = await revokeAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: work.id,
			actor: BOT,
			now: T0 + 31,
		});
		if (!g1.ok || !r1.ok) throw new Error("grant/revoke failed");
		const ruleCascade = await revertAdminBotChange(db, {
			changeId: g1.changeId,
			actor: OWNER,
			now: T0 + 32,
			cascade: true,
		});
		expect(ruleCascade).toMatchObject({
			ok: true,
			data: {
				revertedChangeId: g1.changeId,
				revertedChangeIds: [r1.changeId, g1.changeId],
			},
		});
		expect(
			(
				await checkQuestion(db, {
					fromAgentId: muse.id,
					toAgentName: "grok",
					categoryName: "work",
					now: T0 + 33,
				})
			).allowed,
		).toBe(false);

		// Owner rule on a bot-created category refuses category cascade.
		const cat2 = await createCategory(db, {
			name: "owner-used",
			actor: BOT,
			now: T0 + 40,
		});
		if (!cat2.ok) throw new Error("cat2 failed");
		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: cat2.data.category.id,
			actor: OWNER,
			now: T0 + 41,
		});
		expect(
			await revertAdminBotChange(db, {
				changeId: cat2.changeId,
				actor: OWNER,
				now: T0 + 42,
				cascade: true,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });

		// Cascade undo for description_rejected followed by a newer admin_bot description_approved.
		const d1Sub = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "draft 1 rejected",
			now: T0 + 50,
		});
		if (!d1Sub.ok) throw new Error("d1 submit failed");
		const d1Rej = await rejectPendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: d1Sub.data.pending.submissionId,
			actor: BOT,
			now: T0 + 51,
		});
		const d2Sub = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "draft 2 approved",
			now: T0 + 52,
		});
		if (!d1Rej.ok || !d2Sub.ok) throw new Error("d1/d2 setup failed");
		const d2App = await approvePendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: d2Sub.data.pending.submissionId,
			actor: BOT,
			now: T0 + 53,
		});
		if (!d2App.ok) throw new Error("d2 approve failed");

		expect(
			await revertAdminBotChange(db, {
				changeId: d1Rej.changeId,
				actor: OWNER,
				now: T0 + 54,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });

		const descCascade = await revertAdminBotChange(db, {
			changeId: d1Rej.changeId,
			actor: OWNER,
			now: T0 + 55,
			cascade: true,
		});
		expect(descCascade).toMatchObject({
			ok: true,
			data: {
				revertedChangeId: d1Rej.changeId,
				revertedChangeIds: [d2App.changeId, d1Rej.changeId],
			},
		});
		expect((await loadAgent(grok.id))?.description).toBe("");
		expect(await loadPendingDescription(grok.id)).toMatchObject({
			agentId: grok.id,
			submissionId: d1Sub.data.pending.submissionId,
			description: "draft 1 rejected",
		});
	});
});
