import { beforeEach, describe, expect, it } from "vitest";
import {
	answerQuestion,
	fetchInbox,
	type InboxItem,
	recordBlockedQuestion,
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

describe("a question the bridge blocked", () => {
	it("is stored without a body and never delivered", async () => {
		const { questionId } = await recordBlockedQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			now: T0,
		});
		expect(await getRow(db, questionId)).toMatchObject({
			kind: "question",
			status: "blocked",
			from_agent_id: world.asker.id,
			to_agent_id: world.responder.id,
			category_id: world.category.id,
			body: null,
			expires_at: null,
		});
		expect(await fetchInbox(db, world.responder.id, T0)).toEqual([]);

		// The maintenance run leaves it alone.
		const result = await runInboxMaintenance(db, T0 + 30 * DAY_MS);
		expect(result).toEqual({ expiredQuestions: [], bodiesDeleted: 0 });
		expect((await getRow(db, questionId)).status).toBe("blocked");
	});

	it("can lack a recipient and a category", async () => {
		const { questionId } = await recordBlockedQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: null,
			categoryId: null,
			now: T0,
		});
		expect(await getRow(db, questionId)).toMatchObject({
			to_agent_id: null,
			category_id: null,
		});
		expect(await repliesTo(db, questionId)).toHaveLength(1);
	});
});

describe("the three kinds of rejection", () => {
	/** Produces every kind of rejection within the 7-day reply TTL and returns the question IDs. */
	async function rejectInEveryWay(): Promise<{
		questions: Record<string, string>;
		readyAt: number;
	}> {
		const expired = await ask(world, T0);
		const tBase = expired.expiresAt;
		const maintenance = await runInboxMaintenance(db, tBase);
		expect(maintenance.expiredQuestions).toEqual([
			{
				questionId: expired.questionId,
				fromAgentId: world.asker.id,
				toAgentId: world.responder.id,
				categoryId: world.category.id,
			},
		]);

		const blocked = await recordBlockedQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: world.responder.id,
			categoryId: world.category.id,
			now: tBase,
		});
		const blockedUnknown = await recordBlockedQuestion(db, {
			fromAgentId: world.asker.id,
			toAgentId: null,
			categoryId: null,
			now: tBase,
		});

		const declined = await ask(world, tBase);
		await fetchInbox(db, world.responder.id, tBase + HOUR_MS);
		const result = await answerQuestion(db, {
			questionId: declined.questionId,
			responderAgentId: world.responder.id,
			reply: { kind: "decline" },
			now: tBase + 2 * HOUR_MS,
		});
		expect(result.ok).toBe(true);

		return {
			questions: {
				blocked: blocked.questionId,
				blockedUnknown: blockedUnknown.questionId,
				declined: declined.questionId,
				expired: expired.questionId,
			},
			readyAt: tBase + 3 * HOUR_MS,
		};
	}

	it("look the same in the asker's inbox", async () => {
		const { questions, readyAt } = await rejectInEveryWay();
		const items = await fetchInbox(db, world.asker.id, readyAt);
		expect(items).toHaveLength(4);

		const byQuestion = new Map<string, InboxItem>(
			items.map((item) => [
				item.kind === "question" ? "" : item.inReplyTo,
				item,
			]),
		);
		for (const questionId of Object.values(questions)) {
			const item = byQuestion.get(questionId);
			// Nothing but a random ID and the asker's own question ID.
			expect(item).toEqual({
				kind: "rejection",
				id: expect.any(String),
				inReplyTo: questionId,
			});
			expect(Object.keys(item ?? {}).sort()).toEqual([
				"id",
				"inReplyTo",
				"kind",
			]);
		}
	});

	it("are stored the same way, apart from IDs and creation time", async () => {
		const { questions } = await rejectInEveryWay();
		for (const questionId of Object.values(questions)) {
			const [rejection, ...rest] = await repliesTo(db, questionId);
			expect(rest).toEqual([]);
			const { id, in_reply_to, created_at, ...common } = rejection;
			expect(id).not.toBe(questionId);
			expect(in_reply_to).toBe(questionId);
			expect(created_at).toBeGreaterThanOrEqual(T0);
			expect(common).toEqual({
				kind: "rejection",
				from_agent_id: null,
				to_agent_id: world.asker.id,
				category_id: null,
				body: null,
				status: "sent",
				received_at: null,
				expires_at: null,
				body_deleted_at: null,
			});
		}
	});
});
