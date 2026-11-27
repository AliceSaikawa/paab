import { beforeEach, describe, expect, it } from "vitest";
import {
	answerQuestion,
	BODY_RETENTION_MS,
	countUnread,
	fetchInbox,
	QUESTION_TTL_MS,
	runInboxMaintenance,
} from "../../src/inbox";
import { DAY_MS, HOUR_MS, T0 } from "../helpers/fixtures";
import { ask, createWorld, getRow, repliesTo, type World } from "./support";

let world: World;
let db: D1Database;

beforeEach(async () => {
	world = await createWorld();
	db = world.db;
});

describe("expiry at the 7 day boundary", () => {
	it("uses a deadline of 7 days", () => {
		expect(QUESTION_TTL_MS).toBe(7 * DAY_MS);
	});

	it("keeps a question pending one millisecond before the deadline", async () => {
		const { questionId } = await ask(world, T0);
		const result = await runInboxMaintenance(db, T0 + 7 * DAY_MS - 1);
		expect(result.expiredQuestions).toEqual([]);
		expect((await getRow(db, questionId)).status).toBe("pending");
		expect(await repliesTo(db, questionId)).toEqual([]);
		expect(await countUnread(db, world.responder.id, T0 + 7 * DAY_MS - 1)).toBe(
			1,
		);
	});

	it("expires a question exactly at the deadline and rejects it to the asker", async () => {
		const { questionId } = await ask(world, T0);
		const now = T0 + 7 * DAY_MS;
		const result = await runInboxMaintenance(db, now);
		expect(result.expiredQuestions.map((q) => q.questionId)).toEqual([
			questionId,
		]);
		expect((await getRow(db, questionId)).status).toBe("expired");

		expect(await fetchInbox(db, world.responder.id, now)).toEqual([]);
		expect(await fetchInbox(db, world.asker.id, now)).toEqual([
			{ kind: "rejection", id: expect.any(String), inReplyTo: questionId },
		]);
	});

	it("stops delivering a question at the deadline even before the run", async () => {
		const { questionId } = await ask(world, T0);
		const now = T0 + 7 * DAY_MS;
		expect(await countUnread(db, world.responder.id, now)).toBe(0);
		expect(await fetchInbox(db, world.responder.id, now)).toEqual([]);
		expect((await getRow(db, questionId)).received_at).toBeNull();
	});

	it("does not expire answered or declined questions", async () => {
		const answered = await ask(world, T0);
		const declined = await ask(world, T0);
		await answerQuestion(db, {
			questionId: answered.questionId,
			responderAgentId: world.responder.id,
			reply: { kind: "answer", body: "Yes." },
			now: T0 + 1,
		});
		await answerQuestion(db, {
			questionId: declined.questionId,
			responderAgentId: world.responder.id,
			reply: { kind: "decline" },
			now: T0 + 1,
		});

		const result = await runInboxMaintenance(db, T0 + 8 * DAY_MS);
		expect(result.expiredQuestions).toEqual([]);
		expect((await getRow(db, answered.questionId)).status).toBe("answered");
		expect((await getRow(db, declined.questionId)).status).toBe("declined");
	});

	it("changes nothing when run again", async () => {
		const { questionId } = await ask(world, T0);
		const now = T0 + 7 * DAY_MS;
		await runInboxMaintenance(db, now);
		expect(await runInboxMaintenance(db, now)).toEqual({
			expiredQuestions: [],
			bodiesDeleted: 0,
		});
		expect(await runInboxMaintenance(db, now + DAY_MS)).toEqual({
			expiredQuestions: [],
			bodiesDeleted: 0,
		});
		expect(await repliesTo(db, questionId)).toHaveLength(1);
	});

	it("leaves one rejection per question when two runs overlap", async () => {
		const asked = await Promise.all([1, 2, 3].map((i) => ask(world, T0 + i)));
		const now = T0 + 8 * DAY_MS;
		const runs = await Promise.all([
			runInboxMaintenance(db, now),
			runInboxMaintenance(db, now),
		]);
		expect(runs.flatMap((run) => run.expiredQuestions)).toHaveLength(3);
		for (const { questionId } of asked) {
			expect(await repliesTo(db, questionId)).toHaveLength(1);
		}
	});

	it("expires more questions than fit in one transaction", async () => {
		const total = 60;
		await db
			.prepare("UPDATE agents SET daily_question_limit = ? WHERE id = ?")
			.bind(total, world.asker.id)
			.run();
		for (let i = 0; i < total; i++) {
			await ask(world, T0 + i);
		}
		const keep = await ask(world, T0 + DAY_MS);

		const result = await runInboxMaintenance(db, T0 + 7 * DAY_MS + total);
		expect(result.expiredQuestions).toHaveLength(total);
		expect((await getRow(db, keep.questionId)).status).toBe("pending");
		expect(await countUnread(db, world.asker.id, T0 + 8 * DAY_MS)).toBe(total);
	});
});

describe("body deletion at the 24 hour boundary", () => {
	const RECEIVED = T0 + HOUR_MS;

	it("uses a retention of 24 hours", () => {
		expect(BODY_RETENTION_MS).toBe(DAY_MS);
	});

	/** Asks at T0, delivers at RECEIVED and answers right after. */
	async function answeredQuestion() {
		const { questionId } = await ask(world, T0, "Question text");
		await fetchInbox(db, world.responder.id, RECEIVED);
		const result = await answerQuestion(db, {
			questionId,
			responderAgentId: world.responder.id,
			reply: { kind: "answer", body: "Answer text" },
			now: RECEIVED + 1,
		});
		if (!result.ok) {
			throw new Error(result.reason);
		}
		return { questionId, answerId: result.replyId };
	}

	it("keeps the body of an answered question until 24 hours after receipt", async () => {
		const { questionId } = await answeredQuestion();
		const result = await runInboxMaintenance(db, RECEIVED + DAY_MS - 1);
		expect(result.bodiesDeleted).toBe(0);
		expect(await getRow(db, questionId)).toMatchObject({
			body: "Question text",
			body_deleted_at: null,
		});
	});

	it("deletes the body of an answered question exactly 24 hours after receipt", async () => {
		const { questionId } = await answeredQuestion();
		const result = await runInboxMaintenance(db, RECEIVED + DAY_MS);
		expect(result.bodiesDeleted).toBe(1);
		expect(await getRow(db, questionId)).toMatchObject({
			status: "answered",
			body: null,
			body_deleted_at: RECEIVED + DAY_MS,
			received_at: RECEIVED,
		});
	});

	it("deletes the body of an answer 24 hours after the asker received it", async () => {
		const { answerId } = await answeredQuestion();
		const fetched = T0 + 3 * DAY_MS;
		await fetchInbox(db, world.asker.id, fetched);

		await runInboxMaintenance(db, fetched + DAY_MS - 1);
		expect((await getRow(db, answerId)).body).toBe("Answer text");

		await runInboxMaintenance(db, fetched + DAY_MS);
		expect(await getRow(db, answerId)).toMatchObject({
			body: null,
			body_deleted_at: fetched + DAY_MS,
		});
	});

	it("keeps the body of an answer the asker has not fetched", async () => {
		const { answerId } = await answeredQuestion();
		await runInboxMaintenance(db, T0 + 30 * DAY_MS);
		expect((await getRow(db, answerId)).body).toBe("Answer text");
		const [item] = await fetchInbox(db, world.asker.id, T0 + 30 * DAY_MS);
		expect(item).toMatchObject({ kind: "answer", body: "Answer text" });
	});

	it("deletes the body of a declined question 24 hours after receipt", async () => {
		const { questionId } = await ask(world, T0);
		await fetchInbox(db, world.responder.id, RECEIVED);
		await answerQuestion(db, {
			questionId,
			responderAgentId: world.responder.id,
			reply: { kind: "decline" },
			now: RECEIVED + 1,
		});

		await runInboxMaintenance(db, RECEIVED + DAY_MS - 1);
		expect((await getRow(db, questionId)).body).not.toBeNull();
		await runInboxMaintenance(db, RECEIVED + DAY_MS);
		expect((await getRow(db, questionId)).body).toBeNull();
	});

	it("keeps the body of a received question that is still pending", async () => {
		const { questionId } = await ask(world, T0);
		await fetchInbox(db, world.responder.id, RECEIVED);
		const result = await runInboxMaintenance(db, RECEIVED + 3 * DAY_MS);
		expect(result.bodiesDeleted).toBe(0);
		expect((await getRow(db, questionId)).body).not.toBeNull();
	});

	it("deletes the body of a received question that expired, 24 hours after receipt", async () => {
		const { questionId, expiresAt } = await ask(world, T0);
		const received = expiresAt - HOUR_MS;
		await fetchInbox(db, world.responder.id, received);

		// Expired, but received less than 24 hours ago.
		await runInboxMaintenance(db, received + DAY_MS - 1);
		expect(await getRow(db, questionId)).toMatchObject({
			status: "expired",
			body: "When are you free?",
		});

		await runInboxMaintenance(db, received + DAY_MS);
		expect(await getRow(db, questionId)).toMatchObject({
			body: null,
			body_deleted_at: received + DAY_MS,
		});
	});

	it("deletes the body of a never received question as soon as it expires", async () => {
		const { questionId, expiresAt } = await ask(world, T0);

		await runInboxMaintenance(db, expiresAt - 1);
		expect((await getRow(db, questionId)).body).not.toBeNull();

		const result = await runInboxMaintenance(db, expiresAt);
		expect(result.bodiesDeleted).toBe(1);
		expect(await getRow(db, questionId)).toMatchObject({
			status: "expired",
			received_at: null,
			body: null,
			body_deleted_at: expiresAt,
		});
	});
});
