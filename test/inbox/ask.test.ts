import { beforeEach, describe, expect, it } from "vitest";
import {
	answerQuestion,
	recordBlockedQuestion,
	submitQuestion,
} from "../../src/inbox";
import { DAY_MS, T0 } from "../helpers/fixtures";
import { createWorld, type World } from "./support";

let world: World;
let db: D1Database;

beforeEach(async () => {
	world = await createWorld();
	db = world.db;
});

async function setLimit(agentId: string, limit: number): Promise<void> {
	await db
		.prepare("UPDATE agents SET daily_question_limit = ? WHERE id = ?")
		.bind(limit, agentId)
		.run();
}

async function pendingCount(fromAgentId: string): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM messages WHERE kind = 'question' AND status = 'pending' AND from_agent_id = ?",
		)
		.bind(fromAgentId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe("submitQuestion daily limit atomicity", () => {
	it("admits at most one question when concurrent calls race for the final slot", async () => {
		await setLimit(world.asker.id, 2);
		const first = await submitQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			body: "First",
			now: T0,
		});
		expect(first.ok).toBe(true);

		const concurrent = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				submitQuestion(db, {
					fromAgentId: world.asker.id,
					toAgentId: world.responder.id,
					categoryId: world.category.id,
					body: `Race ${i}`,
					now: T0 + 1,
				}),
			),
		);

		const accepted = concurrent.filter((result) => result.ok);
		const denied = concurrent.filter((result) => !result.ok);
		expect(accepted).toHaveLength(1);
		expect(denied).toHaveLength(4);
		for (const result of denied) {
			expect(result).toEqual({ ok: false, reason: "daily_limit_exceeded" });
		}
		expect(await pendingCount(world.asker.id)).toBe(2);
	});

	it("denies every concurrent call when daily_question_limit is 0", async () => {
		await setLimit(world.asker.id, 0);

		const results = await Promise.all(
			Array.from({ length: 3 }, (_, i) =>
				submitQuestion(db, {
					fromAgentId: world.asker.id,
					toAgentId: world.responder.id,
					categoryId: world.category.id,
					body: `Zero ${i}`,
					now: T0,
				}),
			),
		);

		expect(results).toEqual([
			{ ok: false, reason: "daily_limit_exceeded" },
			{ ok: false, reason: "daily_limit_exceeded" },
			{ ok: false, reason: "daily_limit_exceeded" },
		]);
		expect(await pendingCount(world.asker.id)).toBe(0);
	});

	it("reads the current daily_question_limit from agents at insert time", async () => {
		await setLimit(world.asker.id, 2);
		const first = await submitQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			body: "Before limit drop",
			now: T0,
		});
		expect(first.ok).toBe(true);

		await setLimit(world.asker.id, 1);

		const second = await submitQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			body: "After limit drop",
			now: T0 + 1,
		});
		expect(second).toEqual({ ok: false, reason: "daily_limit_exceeded" });
		expect(await pendingCount(world.asker.id)).toBe(1);
	});

	it("counts blocked questions, ignores answers and other senders, and resets at UTC midnight", async () => {
		await setLimit(world.asker.id, 2);

		// A question from another agent and an answer from the asker do not use asker's quota.
		const fromResponder = await submitQuestion(db, {
			fromAgentId: world.responder.id,
			toAgentId: world.asker.id,
			categoryId: world.category.id,
			body: "From responder",
			now: T0,
		});
		if (!fromResponder.ok) throw new Error(fromResponder.reason);
		const answered = await answerQuestion(db, {
			questionId: fromResponder.questionId,
			responderAgentId: world.asker.id,
			reply: { kind: "answer", body: "Reply from asker" },
			now: T0 + 1,
		});
		expect(answered.ok).toBe(true);

		// One blocked question plus one accepted question fills the quota of 2.
		await recordBlockedQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			now: T0 + 2,
		});
		const secondSlot = await submitQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			body: "Second slot",
			now: T0 + 3,
		});
		expect(secondSlot.ok).toBe(true);

		const endOfDay = await submitQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			body: "Over limit before midnight",
			now: T0 + DAY_MS - 1,
		});
		expect(endOfDay).toEqual({ ok: false, reason: "daily_limit_exceeded" });

		const nextDay = await submitQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			body: "Fresh UTC day",
			now: T0 + DAY_MS,
		});
		expect(nextDay.ok).toBe(true);
	});

	it("throws when the sender agent does not exist", async () => {
		await expect(
			submitQuestion(db, {
				fromAgentId: "missing-agent",
				toAgentId: world.responder.id,
				categoryId: world.category.id,
				body: "No sender",
				now: T0,
			}),
		).rejects.toThrow("Unknown sender agent");
	});
});
