import { beforeEach, describe, expect, it } from "vitest";
import { insertMessage, newId } from "../../src/db";
import {
	answerQuestion,
	fetchInbox,
	recordBlockedQuestion,
	runInboxMaintenance,
} from "../../src/inbox";
import { HOUR_MS, T0 } from "../helpers/fixtures";
import { ask, createWorld, getRow, repliesTo, type World } from "./support";

let world: World;
let db: D1Database;

beforeEach(async () => {
	world = await createWorld();
	db = world.db;
});

function answer(questionId: string, responderAgentId: string, now: number) {
	return answerQuestion(db, {
		questionId,
		responderAgentId,
		reply: { kind: "answer", body: "An answer." },
		now,
	});
}

describe("answering", () => {
	it("rejects a reply from an agent that is not the recipient", async () => {
		const { questionId } = await ask(world);
		for (const agent of [world.bystander, world.asker]) {
			expect(await answer(questionId, agent.id, T0 + 1)).toEqual({
				ok: false,
				reason: "not_recipient",
			});
		}
		expect((await getRow(db, questionId)).status).toBe("pending");
		expect(await repliesTo(db, questionId)).toEqual([]);
	});

	it("rejects a second reply, whether an answer or a refusal", async () => {
		const { questionId } = await ask(world);
		const first = await answer(questionId, world.responder.id, T0 + 1);
		expect(first.ok).toBe(true);

		expect(await answer(questionId, world.responder.id, T0 + 2)).toEqual({
			ok: false,
			reason: "already_replied",
		});
		expect(
			await answerQuestion(db, {
				questionId,
				responderAgentId: world.responder.id,
				reply: { kind: "decline" },
				now: T0 + 3,
			}),
		).toEqual({ ok: false, reason: "already_replied" });

		expect(await repliesTo(db, questionId)).toHaveLength(1);
		expect((await getRow(db, questionId)).status).toBe("answered");
	});

	it("rejects a reply to a declined question", async () => {
		const { questionId } = await ask(world);
		await answerQuestion(db, {
			questionId,
			responderAgentId: world.responder.id,
			reply: { kind: "decline" },
			now: T0 + 1,
		});
		expect((await getRow(db, questionId)).status).toBe("declined");
		expect(await answer(questionId, world.responder.id, T0 + 2)).toEqual({
			ok: false,
			reason: "already_replied",
		});
		expect(await repliesTo(db, questionId)).toHaveLength(1);
	});

	it("lets only one of several concurrent replies through", async () => {
		const { questionId } = await ask(world);
		const results = await Promise.all(
			[1, 2, 3, 4].map((i) => answer(questionId, world.responder.id, T0 + i)),
		);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(
			results.filter((r) => !r.ok && r.reason === "already_replied"),
		).toHaveLength(3);
		expect(await repliesTo(db, questionId)).toHaveLength(1);
	});

	it("turns a unique index violation into a result instead of throwing", async () => {
		// A state the module never produces: a reply exists, yet the question
		// is still pending. Only the unique index stops a second reply here.
		const { questionId } = await ask(world);
		await insertMessage(db, {
			id: newId(),
			kind: "rejection",
			fromAgentId: null,
			toAgentId: world.asker.id,
			categoryId: null,
			body: null,
			inReplyTo: questionId,
			status: "sent",
			createdAt: T0,
			receivedAt: null,
			expiresAt: null,
			bodyDeletedAt: null,
			availableAt: null,
		}).run();

		expect(await answer(questionId, world.responder.id, T0 + 1)).toEqual({
			ok: false,
			reason: "already_replied",
		});
		expect(await repliesTo(db, questionId)).toHaveLength(1);
	});

	it("reports an unknown question, a reply ID and a blocked question as not found", async () => {
		const { questionId } = await ask(world);
		const answered = await answer(questionId, world.responder.id, T0 + 1);
		if (!answered.ok) {
			throw new Error(answered.reason);
		}
		const blocked = await recordBlockedQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			now: T0,
		});

		for (const id of [newId(), answered.replyId, blocked.questionId]) {
			expect(await answer(id, world.responder.id, T0 + 2)).toEqual({
				ok: false,
				reason: "not_found",
			});
		}
		expect(await repliesTo(db, blocked.questionId)).toHaveLength(1);
	});

	it("marks an unfetched question as received when it is answered", async () => {
		const { questionId } = await ask(world);
		await answer(questionId, world.responder.id, T0 + HOUR_MS);
		expect((await getRow(db, questionId)).received_at).toBe(T0 + HOUR_MS);
	});

	it("keeps the original receipt time when a fetched question is answered", async () => {
		const { questionId } = await ask(world);
		await fetchInbox(db, world.responder.id, T0 + 1);
		await answer(questionId, world.responder.id, T0 + HOUR_MS);
		expect((await getRow(db, questionId)).received_at).toBe(T0 + 1);
	});
});

describe("the 7 day deadline", () => {
	it("accepts an answer one millisecond before the deadline", async () => {
		const { questionId, expiresAt } = await ask(world);
		expect(
			(await runInboxMaintenance(db, expiresAt - 1)).expiredQuestions,
		).toEqual([]);
		const result = await answer(questionId, world.responder.id, expiresAt - 1);
		expect(result.ok).toBe(true);
	});

	it("rejects an answer at the deadline, before the maintenance run", async () => {
		const { questionId, expiresAt } = await ask(world);
		expect(await answer(questionId, world.responder.id, expiresAt)).toEqual({
			ok: false,
			reason: "expired",
		});
		expect(await repliesTo(db, questionId)).toEqual([]);
	});

	it("rejects an answer after the maintenance run expired the question", async () => {
		const { questionId, expiresAt } = await ask(world);
		await runInboxMaintenance(db, expiresAt);
		expect((await getRow(db, questionId)).status).toBe("expired");

		// Even with a clock that is still before the deadline.
		for (const now of [expiresAt - 1, expiresAt + HOUR_MS]) {
			expect(await answer(questionId, world.responder.id, now)).toEqual({
				ok: false,
				reason: "expired",
			});
		}
		expect(await repliesTo(db, questionId)).toHaveLength(1);
	});

	it("leaves exactly one reply when an answer races the expiry", async () => {
		for (let round = 0; round < 5; round++) {
			const { questionId, expiresAt } = await ask(world, T0 + round);
			const [answered, maintenance] = await Promise.all([
				answer(questionId, world.responder.id, expiresAt - 1),
				runInboxMaintenance(db, expiresAt),
			]);

			const replies = await repliesTo(db, questionId);
			expect(replies).toHaveLength(1);
			const expired = maintenance.expiredQuestions.some(
				(q) => q.questionId === questionId,
			);
			expect(expired).toBe(!answered.ok);
			expect((await getRow(db, questionId)).status).toBe(
				answered.ok ? "answered" : "expired",
			);
			expect(replies[0].kind).toBe(answered.ok ? "answer" : "rejection");
		}
	});
});
