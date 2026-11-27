import { beforeEach, describe, expect, it } from "vitest";
import { insertAllowRule, insertMessage, newId } from "../../src/db";
import { checkQuestion, utcDayStart } from "../../src/policy";
import type { Agent, Category, Message } from "../../src/types";
import { createTestDb } from "../helpers/db";
import {
	DAY_MS,
	HOUR_MS,
	seedAgent,
	seedCategory,
	T0,
} from "../helpers/fixtures";

let db: D1Database;
let alice: Agent;
let bob: Agent;
let schedule: Category;

async function allow(from: Agent, to: Agent, category: Category) {
	await insertAllowRule(db, {
		fromAgentId: from.id,
		toAgentId: to.id,
		categoryId: category.id,
		createdAt: T0,
	}).run();
}

/** Records a question from `from`, as the caller of the check would. */
async function recordQuestion(
	from: Agent,
	createdAt: number,
	overrides: Partial<Message> = {},
): Promise<Message> {
	const message: Message = {
		id: newId(),
		kind: "question",
		fromAgentId: from.id,
		toAgentId: bob.id,
		categoryId: schedule.id,
		body: "q",
		inReplyTo: null,
		status: "pending",
		createdAt,
		receivedAt: null,
		expiresAt: createdAt + 7 * DAY_MS,
		bodyDeletedAt: null,
		...overrides,
	};
	await insertMessage(db, message).run();
	return message;
}

function check(
	from: Agent,
	toAgentName: string,
	categoryName: string,
	now = T0,
) {
	return checkQuestion(db, {
		fromAgentId: from.id,
		toAgentName,
		categoryName,
		now,
	});
}

async function suspend(agent: Agent) {
	await db
		.prepare("UPDATE agents SET status = 'suspended' WHERE id = ?")
		.bind(agent.id)
		.run();
}

beforeEach(async () => {
	db = await createTestDb();
	alice = await seedAgent(db, { name: "alice", dailyQuestionLimit: 3 });
	bob = await seedAgent(db, { name: "bob" });
	schedule = await seedCategory(db, { name: "schedule" });
	await allow(alice, bob, schedule);
});

describe("allow rules", () => {
	it("allows a combination that has a rule and returns the resolved IDs", async () => {
		expect(await check(alice, "bob", "schedule")).toEqual({
			allowed: true,
			toAgentId: bob.id,
			categoryId: schedule.id,
		});
	});

	it("denies the reverse direction unless it has its own rule", async () => {
		expect(await check(bob, "alice", "schedule")).toEqual({
			allowed: false,
			reasonCode: "no_allow_rule",
			toAgentId: alice.id,
			categoryId: schedule.id,
		});

		await allow(bob, alice, schedule);
		expect((await check(bob, "alice", "schedule")).allowed).toBe(true);
	});

	it("denies a category the rule does not cover", async () => {
		const health = await seedCategory(db, { name: "health" });
		expect(await check(alice, "bob", "health")).toEqual({
			allowed: false,
			reasonCode: "no_allow_rule",
			toAgentId: bob.id,
			categoryId: health.id,
		});
	});

	it("denies a recipient the rule does not cover", async () => {
		const carol = await seedAgent(db, { name: "carol" });
		expect(await check(alice, "carol", "schedule")).toEqual({
			allowed: false,
			reasonCode: "no_allow_rule",
			toAgentId: carol.id,
			categoryId: schedule.id,
		});
	});
});

describe("denial conditions", () => {
	it("denies a recipient that does not exist", async () => {
		expect(await check(alice, "nobody", "schedule")).toEqual({
			allowed: false,
			reasonCode: "recipient_not_found",
			toAgentId: null,
			categoryId: schedule.id,
		});
	});

	it("matches names exactly", async () => {
		expect(await check(alice, "Bob", "schedule")).toMatchObject({
			reasonCode: "recipient_not_found",
		});
		expect(await check(alice, "bob", "Schedule")).toMatchObject({
			reasonCode: "category_not_found",
		});
	});

	it("denies a suspended sender", async () => {
		await suspend(alice);
		expect(await check(alice, "bob", "schedule")).toEqual({
			allowed: false,
			reasonCode: "sender_suspended",
			toAgentId: bob.id,
			categoryId: schedule.id,
		});
	});

	it("denies a suspended recipient", async () => {
		await suspend(bob);
		expect(await check(alice, "bob", "schedule")).toEqual({
			allowed: false,
			reasonCode: "recipient_suspended",
			toAgentId: bob.id,
			categoryId: schedule.id,
		});
	});

	it("denies a question addressed to the sender itself", async () => {
		expect(await check(alice, "alice", "schedule")).toEqual({
			allowed: false,
			reasonCode: "self_addressed",
			toAgentId: alice.id,
			categoryId: schedule.id,
		});
	});

	it("denies a category that does not exist", async () => {
		expect(await check(alice, "bob", "nothing")).toEqual({
			allowed: false,
			reasonCode: "category_not_found",
			toAgentId: bob.id,
			categoryId: null,
		});
	});

	it("throws when the sender does not exist", async () => {
		await expect(
			checkQuestion(db, {
				fromAgentId: "missing",
				toAgentName: "bob",
				categoryName: "schedule",
				now: T0,
			}),
		).rejects.toThrow("Unknown sender agent");
	});
});

describe("precedence when several conditions hold", () => {
	it("reports a suspended sender before anything else", async () => {
		await suspend(alice);
		expect(await check(alice, "nobody", "nothing")).toEqual({
			allowed: false,
			reasonCode: "sender_suspended",
			toAgentId: null,
			categoryId: null,
		});
		expect(await check(alice, "alice", "schedule")).toMatchObject({
			reasonCode: "sender_suspended",
		});
	});

	it("reports a missing recipient before a missing category", async () => {
		expect(await check(alice, "nobody", "nothing")).toEqual({
			allowed: false,
			reasonCode: "recipient_not_found",
			toAgentId: null,
			categoryId: null,
		});
	});

	it("reports a suspended recipient before a missing category or rule", async () => {
		const carol = await seedAgent(db, { name: "carol", status: "suspended" });
		expect(await check(alice, "carol", "nothing")).toEqual({
			allowed: false,
			reasonCode: "recipient_suspended",
			toAgentId: carol.id,
			categoryId: null,
		});
		expect(await check(alice, "carol", "schedule")).toMatchObject({
			reasonCode: "recipient_suspended",
		});
	});

	it("reports the daily limit right after a suspended sender", async () => {
		for (let i = 0; i < 3; i++) await recordQuestion(alice, T0);
		await seedAgent(db, { name: "carol" });

		expect(await check(alice, "carol", "schedule")).toMatchObject({
			allowed: false,
			reasonCode: "daily_limit_exceeded",
		});
		expect(await check(alice, "bob", "nothing")).toMatchObject({
			allowed: false,
			reasonCode: "daily_limit_exceeded",
			toAgentId: bob.id,
			categoryId: null,
		});
		expect(await check(alice, "alice", "schedule")).toMatchObject({
			allowed: false,
			reasonCode: "daily_limit_exceeded",
		});
		expect(await check(alice, "nobody", "schedule")).toMatchObject({
			allowed: false,
			reasonCode: "daily_limit_exceeded",
			toAgentId: null,
			categoryId: schedule.id,
		});
		expect(await check(alice, "bob", "schedule")).toMatchObject({
			allowed: false,
			reasonCode: "daily_limit_exceeded",
			toAgentId: bob.id,
			categoryId: schedule.id,
		});

		await suspend(alice);
		expect(await check(alice, "bob", "schedule")).toMatchObject({
			allowed: false,
			reasonCode: "sender_suspended",
		});
	});
});

describe("daily question limit", () => {
	it("allows up to the limit and denies the next question", async () => {
		// The limit is 3. Each allowed question is recorded before the next check.
		for (let i = 0; i < 3; i++) {
			expect((await check(alice, "bob", "schedule", T0 + i)).allowed).toBe(
				true,
			);
			await recordQuestion(alice, T0 + i);
		}
		expect(await check(alice, "bob", "schedule", T0 + 3)).toEqual({
			allowed: false,
			reasonCode: "daily_limit_exceeded",
			toAgentId: bob.id,
			categoryId: schedule.id,
		});
	});

	it("allows again once the UTC date changes", async () => {
		for (let i = 0; i < 3; i++) await recordQuestion(alice, T0 + i * HOUR_MS);

		const lastMoment = T0 + DAY_MS - 1;
		expect(await check(alice, "bob", "schedule", lastMoment)).toMatchObject({
			reasonCode: "daily_limit_exceeded",
		});
		expect((await check(alice, "bob", "schedule", T0 + DAY_MS)).allowed).toBe(
			true,
		);
	});

	it("does not count questions from the previous UTC day", async () => {
		for (let i = 0; i < 3; i++) await recordQuestion(alice, T0 - 1);
		expect((await check(alice, "bob", "schedule", T0)).allowed).toBe(true);
	});

	it("counts questions the bridge blocked", async () => {
		await recordQuestion(alice, T0);
		await recordQuestion(alice, T0, { status: "blocked" });
		await recordQuestion(alice, T0, {
			status: "blocked",
			toAgentId: null,
			categoryId: null,
			expiresAt: null,
		});
		expect(await check(alice, "bob", "schedule")).toMatchObject({
			reasonCode: "daily_limit_exceeded",
		});
	});

	it("counts only questions, and only the sender's own", async () => {
		await allow(bob, alice, schedule);
		const fromBob = await recordQuestion(bob, T0, { toAgentId: alice.id });
		await recordQuestion(bob, T0, { toAgentId: alice.id });
		await recordQuestion(bob, T0, { toAgentId: alice.id });
		// Alice answers one of them: a message from her that is not a question.
		await recordQuestion(alice, T0, {
			kind: "answer",
			status: "sent",
			inReplyTo: fromBob.id,
			expiresAt: null,
		});
		await recordQuestion(alice, T0);
		await recordQuestion(alice, T0);

		expect((await check(alice, "bob", "schedule")).allowed).toBe(true);
	});

	it("denies every question when the limit is zero", async () => {
		const mute = await seedAgent(db, { name: "mute", dailyQuestionLimit: 0 });
		await allow(mute, bob, schedule);
		expect(await check(mute, "bob", "schedule")).toMatchObject({
			reasonCode: "daily_limit_exceeded",
		});
	});
});

describe("utcDayStart", () => {
	it("returns midnight UTC of the day that contains the instant", () => {
		expect(utcDayStart(T0)).toBe(T0);
		expect(utcDayStart(T0 + DAY_MS - 1)).toBe(T0);
		expect(utcDayStart(T0 + DAY_MS)).toBe(T0 + DAY_MS);
	});
});
