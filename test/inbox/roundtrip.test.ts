import { beforeEach, describe, expect, it } from "vitest";
import {
	answerQuestion,
	countUnread,
	fetchInbox,
	QUESTION_TTL_MS,
} from "../../src/inbox";
import { HOUR_MS, T0 } from "../helpers/fixtures";
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
