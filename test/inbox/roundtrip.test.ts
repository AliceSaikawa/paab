import { beforeEach, describe, expect, it } from "vitest";
import {
	answerQuestion,
	countUnread,
	fetchInbox,
	QUESTION_TTL_MS,
	runInboxMaintenance,
} from "../../src/inbox";
import { DAY_MS, HOUR_MS, T0 } from "../helpers/fixtures";
import { ask, createWorld, getRow, type World } from "./support";

let world: World;
let db: D1Database;

beforeEach(async () => {
	world = await createWorld();
	db = world.db;
});

describe("question and answer round trip", () => {
	it("delivers the question to the recipient and the answer to the asker", async () => {
		const { asker, responder, category } = world;
		const { questionId, expiresAt } = await ask(
			world,
			T0,
			"When are you free?",
		);
		expect(expiresAt).toBe(T0 + QUESTION_TTL_MS);

		expect(await fetchInbox(db, responder.id, T0 + HOUR_MS)).toEqual([
			{
				kind: "question",
				id: questionId,
				fromAgentId: asker.id,
				categoryId: category.id,
				body: "When are you free?",
				createdAt: T0,
				expiresAt,
			},
		]);

		const result = await answerQuestion(db, {
			questionId,
			responderAgentId: responder.id,
			reply: { kind: "answer", body: "Friday afternoon." },
			now: T0 + 2 * HOUR_MS,
		});
		if (!result.ok) {
			throw new Error(result.reason);
		}
		expect(result.askerAgentId).toBe(asker.id);
		expect(result.categoryId).toBe(category.id);
		expect((await getRow(db, questionId)).status).toBe("answered");

		expect(await fetchInbox(db, asker.id, T0 + 3 * HOUR_MS)).toEqual([
			{
				kind: "answer",
				id: result.replyId,
				inReplyTo: questionId,
				fromAgentId: responder.id,
				categoryId: category.id,
				body: "Friday afternoon.",
				createdAt: T0 + 2 * HOUR_MS,
			},
		]);
	});

	it("gives nothing to agents the messages are not addressed to", async () => {
		const { questionId } = await ask(world);
		expect(await fetchInbox(db, world.bystander.id, T0)).toEqual([]);
		expect(await fetchInbox(db, world.asker.id, T0)).toEqual([]);
		expect((await getRow(db, questionId)).received_at).toBeNull();
	});
});

describe("receiving a message once", () => {
	it("does not return a message on the second fetch", async () => {
		const { questionId } = await ask(world);
		expect(await fetchInbox(db, world.responder.id, T0 + 1)).toHaveLength(1);
		expect(await fetchInbox(db, world.responder.id, T0 + 2)).toEqual([]);
		expect((await getRow(db, questionId)).received_at).toBe(T0 + 1);
	});

	it("hands each message to only one of several concurrent fetches", async () => {
		const asked = await Promise.all(
			[1, 2, 3, 4, 5].map((i) => ask(world, T0 + i)),
		);
		const fetches = await Promise.all(
			[1, 2, 3, 4].map(() => fetchInbox(db, world.responder.id, T0 + HOUR_MS)),
		);
		const ids = fetches.flat().map((item) => item.id);
		expect(ids.sort()).toEqual(asked.map((q) => q.questionId).sort());
	});

	it("returns items oldest first", async () => {
		const second = await ask(world, T0 + 2);
		const first = await ask(world, T0 + 1);
		const items = await fetchInbox(db, world.responder.id, T0 + HOUR_MS);
		expect(items.map((item) => item.id)).toEqual([
			first.questionId,
			second.questionId,
		]);
	});
});

describe("unread count", () => {
	it("counts what the next fetch would return", async () => {
		const { asker, responder } = world;
		expect(await countUnread(db, responder.id, T0)).toBe(0);

		const { questionId } = await ask(world);
		await ask(world);
		expect(await countUnread(db, responder.id, T0)).toBe(2);
		expect(await countUnread(db, asker.id, T0)).toBe(0);

		await fetchInbox(db, responder.id, T0);
		expect(await countUnread(db, responder.id, T0)).toBe(0);

		await answerQuestion(db, {
			questionId,
			responderAgentId: responder.id,
			reply: { kind: "answer", body: "Yes." },
			now: T0,
		});
		expect(await countUnread(db, asker.id, T0)).toBe(1);
		await fetchInbox(db, asker.id, T0);
		expect(await countUnread(db, asker.id, T0)).toBe(0);
	});
});

describe("recovering delivered messages", () => {
	it("recovers delivered unanswered unexpired questions in pending_questions mode", async () => {
		const { asker, responder, bystander, category } = world;
		const second = await ask(world, T0 + 2, "Second pending");
		const first = await ask(world, T0 + 1, "First pending");
		const answered = await ask(world, T0 + 3, "Will be answered");
		const declined = await ask(world, T0 + 4, "Will be declined");

		const deliveredAt = T0 + HOUR_MS;
		await fetchInbox(db, responder.id, deliveredAt, "unread");

		const undelivered = await ask(world, T0 + 2 * HOUR_MS, "Not fetched yet");
		await answerQuestion(db, {
			questionId: answered.questionId,
			responderAgentId: responder.id,
			reply: { kind: "answer", body: "Done." },
			now: T0 + 2 * HOUR_MS,
		});
		await answerQuestion(db, {
			questionId: declined.questionId,
			responderAgentId: responder.id,
			reply: { kind: "decline" },
			now: T0 + 2 * HOUR_MS,
		});

		const recoveredAt = T0 + 3 * HOUR_MS;
		const recovered = await fetchInbox(
			db,
			responder.id,
			recoveredAt,
			"pending_questions",
		);
		expect(recovered).toEqual([
			{
				kind: "question",
				id: first.questionId,
				fromAgentId: asker.id,
				categoryId: category.id,
				body: "First pending",
				createdAt: T0 + 1,
				expiresAt: first.expiresAt,
			},
			{
				kind: "question",
				id: second.questionId,
				fromAgentId: asker.id,
				categoryId: category.id,
				body: "Second pending",
				createdAt: T0 + 2,
				expiresAt: second.expiresAt,
			},
		]);

		expect((await getRow(db, first.questionId)).received_at).toBe(deliveredAt);
		expect((await getRow(db, undelivered.questionId)).received_at).toBeNull();
		expect(
			await fetchInbox(db, bystander.id, recoveredAt, "pending_questions"),
		).toEqual([]);
		expect(
			await fetchInbox(db, asker.id, recoveredAt, "pending_questions"),
		).toEqual([]);

		// Past expiry, pending_questions drops the question even before maintenance runs.
		expect(
			await fetchInbox(db, responder.id, first.expiresAt, "pending_questions"),
		).toEqual([expect.objectContaining({ id: second.questionId })]);
		expect(
			await fetchInbox(db, responder.id, second.expiresAt, "pending_questions"),
		).toEqual([]);
	});

	it("recovers delivered pending questions, answers, and rejections in recent mode without extending retention", async () => {
		const { asker, responder, bystander } = world;
		const answeredQ = await ask(world, T0, "Q1");
		const declinedQ = await ask(world, T0 + 1, "Q2");
		const openQ = await ask(world, T0 + 2, "Q3");

		const responderFetchedAt = T0 + HOUR_MS;
		await fetchInbox(db, responder.id, responderFetchedAt);

		const answerRes = await answerQuestion(db, {
			questionId: answeredQ.questionId,
			responderAgentId: responder.id,
			reply: { kind: "answer", body: "Friday." },
			now: T0 + 2 * HOUR_MS,
		});
		if (!answerRes.ok) {
			throw new Error(answerRes.reason);
		}
		const declineRes = await answerQuestion(db, {
			questionId: declinedQ.questionId,
			responderAgentId: responder.id,
			reply: { kind: "decline" },
			now: T0 + 2 * HOUR_MS + 1,
		});
		if (!declineRes.ok) {
			throw new Error(declineRes.reason);
		}

		// Replies are still undelivered, so recent returns nothing for the asker.
		expect(await fetchInbox(db, asker.id, T0 + 3 * HOUR_MS, "recent")).toEqual(
			[],
		);

		const askerFetchedAt = T0 + 3 * HOUR_MS;
		await fetchInbox(db, asker.id, askerFetchedAt);

		// Just before 24h: asker recovers both the answer and the rejection.
		const beforeCutoff = askerFetchedAt + DAY_MS - 1;
		expect(await fetchInbox(db, asker.id, beforeCutoff, "recent")).toEqual([
			{
				kind: "answer",
				id: answerRes.replyId,
				inReplyTo: answeredQ.questionId,
				fromAgentId: responder.id,
				categoryId: world.category.id,
				body: "Friday.",
				createdAt: T0 + 2 * HOUR_MS,
			},
			{
				kind: "rejection",
				id: declineRes.replyId,
				inReplyTo: declinedQ.questionId,
			},
		]);
		expect((await getRow(db, answerRes.replyId)).received_at).toBe(
			askerFetchedAt,
		);
		expect((await getRow(db, declineRes.replyId)).received_at).toBe(
			askerFetchedAt,
		);

		// Another agent cannot recover asker's replies or responder's pending question.
		expect(await fetchInbox(db, bystander.id, beforeCutoff, "recent")).toEqual(
			[],
		);

		// Responder still sees the delivered pending question even after 24h, until expiry.
		expect(
			await fetchInbox(db, responder.id, askerFetchedAt + DAY_MS, "recent"),
		).toEqual([
			expect.objectContaining({ kind: "question", id: openQ.questionId }),
		]);

		// At 24h after asker receipt, maintenance deletes the answer body and recent stops returning replies.
		const atCutoff = askerFetchedAt + DAY_MS;
		await runInboxMaintenance(db, atCutoff);
		expect((await getRow(db, answerRes.replyId)).body).toBeNull();
		expect(await fetchInbox(db, asker.id, atCutoff, "recent")).toEqual([]);
	});
});
