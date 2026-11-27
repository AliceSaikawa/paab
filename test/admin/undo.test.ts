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
import {
	approvePendingDescription,
	rejectPendingDescription,
	submitPendingDescription,
} from "../../src/adminbot";
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

function interceptNthBatch(
	baseDb: D1Database,
	targetCall: number,
	beforeBatch: () => Promise<void>,
): D1Database {
	let callCount = 0;
	return new Proxy(baseDb, {
		get(target, prop) {
			if (prop === "batch") {
				return async <T = unknown>(
					statements: D1PreparedStatement[],
				): Promise<D1Result<T>[]> => {
					callCount += 1;
					if (callCount === targetCall) {
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

	it("reverts description_approved without clobbering unrelated agent fields, detects newer description conflicts, and treats description_rejected as non-undoable", async () => {
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

		// description_rejected is not undoable.
		expect(
			await revertAdminBotChange(db, {
				changeId: rejected.changeId,
				actor: OWNER,
				now: T0 + 7,
			}),
		).toMatchObject({ ok: false, code: "not_undoable" });

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

	it("allows only one concurrent revertAdminBotChange to succeed and records a single change_reverted row", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const grok = await seedAgent(db, { name: "grok", status: "active" });
		const schedule = await seedCategory(db, { name: "schedule" });

		const suspended = await suspendAgent(db, {
			agentId: grok.id,
			actor: BOT,
			now: T0 + 1,
		});
		if (!suspended.ok) throw new Error("suspend failed");

		const suspendResults = await Promise.all([
			revertAdminBotChange(db, {
				changeId: suspended.changeId,
				actor: OWNER,
				now: T0 + 2,
			}),
			revertAdminBotChange(db, {
				changeId: suspended.changeId,
				actor: OWNER,
				now: T0 + 2,
			}),
		]);
		expect(suspendResults.filter((r) => r.ok)).toHaveLength(1);
		expect(
			suspendResults.filter((r) => !r.ok && r.code === "already_reverted"),
		).toHaveLength(1);
		expect((await loadAgent(grok.id))?.status).toBe("active");

		const logsAfterSuspend = await queryChangeLog(db);
		const suspendReverts = logsAfterSuspend.filter(
			(e) => e.action === "change_reverted",
		);
		expect(suspendReverts).toHaveLength(1);
		expect(suspendReverts[0]?.revertedAt).toBeNull();
		expect(
			logsAfterSuspend.find((e) => e.id === suspended.changeId)?.revertedAt,
		).toBe(T0 + 2);

		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: OWNER,
			now: T0 + 3,
		});
		const revoked = await revokeAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: BOT,
			now: T0 + 4,
		});
		if (!revoked.ok) throw new Error("revoke failed");

		const ruleResults = await Promise.all([
			revertAdminBotChange(db, {
				changeId: revoked.changeId,
				actor: OWNER,
				now: T0 + 5,
			}),
			revertAdminBotChange(db, {
				changeId: revoked.changeId,
				actor: OWNER,
				now: T0 + 5,
			}),
		]);
		expect(ruleResults.filter((r) => r.ok)).toHaveLength(1);
		expect(
			ruleResults.filter((r) => !r.ok && r.code === "already_reverted"),
		).toHaveLength(1);
		expect(
			(await queryChangeLog(db)).filter((e) => e.action === "change_reverted"),
		).toHaveLength(2);
	});

	it("aborts without overwriting when an intervening edit occurs between conflict check and restore batch", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const grok = await seedAgent(db, {
			name: "grok",
			status: "active",
			description: "initial bio",
			dailyQuestionLimit: 20,
		});
		const schedule = await seedCategory(db, { name: "schedule" });

		// 1. Intervening resumeAgent (with change_log) between check and write batch.
		const suspended = await suspendAgent(db, {
			agentId: grok.id,
			actor: BOT,
			now: T0 + 1,
		});
		if (!suspended.ok) throw new Error("suspend failed");

		const racedResumeDb = interceptNthBatch(db, 2, async () => {
			const resumed = await resumeAgent(db, {
				agentId: grok.id,
				actor: OWNER,
				now: T0 + 2,
			});
			expect(resumed.ok).toBe(true);
		});
		const failedResumeUndo = await revertAdminBotChange(racedResumeDb, {
			changeId: suspended.changeId,
			actor: OWNER,
			now: T0 + 3,
		});
		expect(failedResumeUndo).toMatchObject({
			ok: false,
			code: "conflict_newer_change",
		});
		expect((await loadAgent(grok.id))?.status).toBe("active");
		const logsAfterResumeRace = await queryChangeLog(db);
		expect(
			logsAfterResumeRace.find((e) => e.id === suspended.changeId)?.revertedAt,
		).toBeNull();
		expect(
			logsAfterResumeRace.filter((e) => e.action === "change_reverted"),
		).toHaveLength(0);

		// 2. Intervening ABA edit (suspended -> active -> suspended) with change_log rows.
		const suspended2 = await suspendAgent(db, {
			agentId: grok.id,
			actor: BOT,
			now: T0 + 4,
		});
		if (!suspended2.ok) throw new Error("suspend2 failed");

		const racedAbaDb = interceptNthBatch(db, 2, async () => {
			await resumeAgent(db, { agentId: grok.id, actor: OWNER, now: T0 + 5 });
			await suspendAgent(db, { agentId: grok.id, actor: OWNER, now: T0 + 6 });
		});
		expect(
			await revertAdminBotChange(racedAbaDb, {
				changeId: suspended2.changeId,
				actor: OWNER,
				now: T0 + 7,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
		expect((await loadAgent(grok.id))?.status).toBe("suspended");
		expect(
			(await queryChangeLog(db)).filter((e) => e.action === "change_reverted"),
		).toHaveLength(0);

		// 3. Intervening direct SQL edit (without change_log) between check and write batch.
		const limitLowered = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 8,
			actor: BOT,
			now: T0 + 8,
		});
		if (!limitLowered.ok || limitLowered.changeId === null) {
			throw new Error("limitLowered failed");
		}

		const racedDirectSqlDb = interceptNthBatch(db, 2, async () => {
			await db
				.prepare("UPDATE agents SET daily_question_limit = ? WHERE id = ?")
				.bind(3, grok.id)
				.run();
		});
		expect(
			await revertAdminBotChange(racedDirectSqlDb, {
				changeId: limitLowered.changeId,
				actor: OWNER,
				now: T0 + 9,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
		expect((await loadAgent(grok.id))?.dailyQuestionLimit).toBe(3);
		expect(
			(await queryChangeLog(db)).find((e) => e.id === limitLowered.changeId)
				?.revertedAt,
		).toBeNull();
		expect(
			(await queryChangeLog(db)).filter((e) => e.action === "change_reverted"),
		).toHaveLength(0);

		// 4. Subsequent undo call also fails when state diverged without change_log.
		expect(
			await revertAdminBotChange(db, {
				changeId: limitLowered.changeId,
				actor: OWNER,
				now: T0 + 10,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
		expect((await loadAgent(grok.id))?.dailyQuestionLimit).toBe(3);

		// 5. Unrelated concurrent edit (description update) does not block or get clobbered by limit undo.
		const limitLowered2 = await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 1,
			actor: BOT,
			now: T0 + 11,
		});
		if (!limitLowered2.ok || limitLowered2.changeId === null) {
			throw new Error("limitLowered2 failed");
		}
		const racedUnrelatedDb = interceptNthBatch(db, 2, async () => {
			const descRes = await updateAgent(db, {
				agentId: grok.id,
				description: "concurrent bio update",
				actor: OWNER,
				now: T0 + 12,
			});
			expect(descRes.ok).toBe(true);
		});
		expect(
			await revertAdminBotChange(racedUnrelatedDb, {
				changeId: limitLowered2.changeId,
				actor: OWNER,
				now: T0 + 13,
			}),
		).toMatchObject({ ok: true });
		expect(await loadAgent(grok.id)).toMatchObject({
			dailyQuestionLimit: 3,
			description: "concurrent bio update",
		});

		// 6. Concurrent allow_rule grant blocks category_created undo without deleting category.
		const createdCat = await createCategory(db, {
			name: "racing-cat",
			actor: BOT,
			now: T0 + 14,
		});
		if (!createdCat.ok) throw new Error("createCategory failed");

		const racedCatDb = interceptNthBatch(db, 2, async () => {
			const granted = await grantAllowRule(db, {
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: createdCat.data.category.id,
				actor: OWNER,
				now: T0 + 15,
			});
			expect(granted.ok).toBe(true);
		});
		expect(
			await revertAdminBotChange(racedCatDb, {
				changeId: createdCat.changeId,
				actor: OWNER,
				now: T0 + 16,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
		const catStillThere = await db
			.prepare("SELECT id FROM categories WHERE id = ?")
			.bind(createdCat.data.category.id)
			.first();
		expect(catStillThere).not.toBeNull();
		expect(
			(await queryChangeLog(db)).find((e) => e.id === createdCat.changeId)
				?.revertedAt,
		).toBeNull();

		// 7. Concurrent re-grant blocks allow_rule_revoked undo without duplicating change_reverted.
		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: OWNER,
			now: T0 + 17,
		});
		const revokedRule = await revokeAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: BOT,
			now: T0 + 18,
		});
		if (!revokedRule.ok) throw new Error("revokeAllowRule failed");

		const racedRuleDb = interceptNthBatch(db, 2, async () => {
			const regranted = await grantAllowRule(db, {
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
				actor: OWNER,
				now: T0 + 19,
			});
			expect(regranted.ok).toBe(true);
		});
		expect(
			await revertAdminBotChange(racedRuleDb, {
				changeId: revokedRule.changeId,
				actor: OWNER,
				now: T0 + 20,
			}),
		).toMatchObject({ ok: false, code: "conflict_newer_change" });
		expect(
			(await queryChangeLog(db)).find((e) => e.id === revokedRule.changeId)
				?.revertedAt,
		).toBeNull();
	});
});
