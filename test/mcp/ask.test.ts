import { beforeEach, describe, expect, it } from "vitest";
import { configureAgentWebhook } from "../../src/admin";
import { queryAuditLog } from "../../src/audit";
import { ANSWER_MAX_LENGTH, QUESTION_MAX_LENGTH } from "../../src/mcp";
import { DAY_MS, T0 } from "../helpers/fixtures";
import {
	askBob,
	call,
	connect,
	createMcpWorld,
	type McpWorld,
	questionIdOf,
	unreadCount,
	withoutFooter,
} from "./support";

let world: McpWorld;

beforeEach(async () => {
	world = await createMcpWorld();
});

async function messageCount(): Promise<number> {
	const row = await world.db
		.prepare("SELECT COUNT(*) AS n FROM messages")
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe("ask", () => {
	it("answers an allowed and a denied question with the same text", async () => {
		const alice = await connect(world.alice.token);
		const allowed = await call(alice, "ask", {
			to: "bob",
			category: "schedule",
			question: "When are you free?",
		});
		const noRule = await call(alice, "ask", {
			to: "bob",
			category: "health",
			question: "When are you free?",
		});
		const unknownRecipient = await call(alice, "ask", {
			to: "nobody",
			category: "schedule",
			question: "When are you free?",
		});

		const normalize = (text: string) =>
			withoutFooter(text).replace(questionIdOf(text), "<id>");
		expect(allowed.isError).toBe(false);
		expect(noRule).toMatchObject({ isError: false });
		expect(unknownRecipient).toMatchObject({ isError: false });
		expect(normalize(noRule.text)).toBe(normalize(allowed.text));
		expect(normalize(unknownRecipient.text)).toBe(normalize(allowed.text));
		expect(normalize(allowed.text)).toContain("check_inbox");
	});

	it(`accepts ${QUESTION_MAX_LENGTH} code points and refuses one more`, async () => {
		const alice = await connect(world.alice.token);
		// Astral characters are two UTF-16 units each, so this also checks
		// that the limit counts code points.
		const longest = "😀".repeat(QUESTION_MAX_LENGTH);

		const accepted = await call(alice, "ask", {
			to: "bob",
			category: "schedule",
			question: longest,
		});
		expect(accepted.isError).toBe(false);
		questionIdOf(accepted.text);

		const before = await messageCount();
		const auditBefore = (await queryAuditLog(world.db)).length;
		const refused = await call(alice, "ask", {
			to: "bob",
			category: "schedule",
			question: `${longest}a`,
		});
		expect(refused.isError).toBe(true);
		expect(refused.text).not.toContain("question_id");
		expect(await messageCount()).toBe(before);
		expect((await queryAuditLog(world.db)).length).toBe(auditBefore);
	});

	it("refuses an empty question without storing it", async () => {
		const alice = await connect(world.alice.token);
		const refused = await call(alice, "ask", {
			to: "bob",
			category: "schedule",
			question: "",
		});
		expect(refused.isError).toBe(true);
		expect(await messageCount()).toBe(0);
	});

	it("suppresses message rows, delayed webhooks, and repeat audit rows after daily_question_limit", async () => {
		await world.db
			.prepare("UPDATE agents SET daily_question_limit = 2 WHERE id = ?")
			.bind(world.alice.agent.id)
			.run();
		await configureAgentWebhook(world.db, {
			agentId: world.alice.agent.id,
			url: "https://hooks.example.com/alice",
			authMode: "paab_hmac",
			actor: { actorType: "owner", actorId: "owner@example.com" },
			now: T0,
		});

		const alice = await connect(world.alice.token, { now: T0 });
		const accepted1 = await call(alice, "ask", {
			to: "bob",
			category: "schedule",
			question: "First?",
		});
		const accepted2 = await call(alice, "ask", {
			to: "bob",
			category: "schedule",
			question: "Second?",
		});
		expect(accepted1.isError).toBe(false);
		expect(accepted2.isError).toBe(false);
		expect(await messageCount()).toBe(2);

		const normalize = (text: string) =>
			withoutFooter(text).replace(questionIdOf(text), "<id>");

		// Repeat over-limit asks (both allowed targets and disallowed targets).
		const over1 = await call(alice, "ask", {
			to: "bob",
			category: "schedule",
			question: "Third?",
		});
		const over2 = await call(alice, "ask", {
			to: "bob",
			category: "schedule",
			question: "Fourth?",
		});
		const overDisallowed = await call(alice, "ask", {
			to: "bob",
			category: "health",
			question: "Disallowed after limit?",
		});
		const overUnknown = await call(alice, "ask", {
			to: "nobody",
			category: "schedule",
			question: "Unknown recipient after limit?",
		});

		for (const res of [over1, over2, overDisallowed, overUnknown]) {
			expect(res.isError).toBe(false);
			expect(normalize(res.text)).toBe(normalize(accepted1.text));
			expect(unreadCount(res.text)).toBe(0);
		}
		expect(questionIdOf(over1.text)).not.toBe(questionIdOf(over2.text));

		// Zero new rows in messages and zero delayed webhooks scheduled for alice.
		expect(await messageCount()).toBe(2);
		const deliveries = await world.db
			.prepare(
				"SELECT COUNT(*) AS n FROM webhook_deliveries WHERE agent_id = ?",
			)
			.bind(world.alice.agent.id)
			.first<{ n: number }>();
		expect(deliveries?.n).toBe(0);

		// At most one daily_limit_exceeded audit row on Day 1.
		const day1LimitAudits = (await queryAuditLog(world.db)).filter(
			(entry) =>
				entry.eventType === "question_blocked" &&
				entry.reasonCode === "daily_limit_exceeded",
		);
		expect(day1LimitAudits).toHaveLength(1);
		expect(day1LimitAudits[0]).toMatchObject({
			fromAgentId: world.alice.agent.id,
			toAgentId: world.bob.agent.id,
			categoryId: world.schedule.id,
			messageId: questionIdOf(over1.text),
			outcome: "denied",
		});

		// Next UTC day resets both the daily question limit and the daily audit cap.
		const aliceDay2 = await connect(world.alice.token, { now: T0 + DAY_MS });
		await askBob(aliceDay2, "Day 2 first");
		await askBob(aliceDay2, "Day 2 second");
		expect(await messageCount()).toBe(4);

		const day2Over1 = await call(aliceDay2, "ask", {
			to: "bob",
			category: "schedule",
			question: "Day 2 third",
		});
		const day2Over2 = await call(aliceDay2, "ask", {
			to: "bob",
			category: "schedule",
			question: "Day 2 fourth",
		});
		expect(unreadCount(day2Over1.text)).toBe(0);
		expect(unreadCount(day2Over2.text)).toBe(0);
		expect(await messageCount()).toBe(4);

		const allLimitAudits = (await queryAuditLog(world.db)).filter(
			(entry) =>
				entry.eventType === "question_blocked" &&
				entry.reasonCode === "daily_limit_exceeded",
		);
		expect(allLimitAudits).toHaveLength(2);
		expect(allLimitAudits[1]?.messageId).toBe(questionIdOf(day2Over1.text));
	});

	it("keeps non-limit bridge blocks recorded until daily_question_limit is reached, then stops writing messages", async () => {
		await world.db
			.prepare("UPDATE agents SET daily_question_limit = 2 WHERE id = ?")
			.bind(world.alice.agent.id)
			.run();
		const alice = await connect(world.alice.token, { now: T0 });

		// Two non-limit bridge blocks below the limit write 2 messages each (4 total).
		await call(alice, "ask", {
			to: "bob",
			category: "health",
			question: "Disallowed 1",
		});
		await call(alice, "ask", {
			to: "nobody",
			category: "schedule",
			question: "Unknown 2",
		});
		expect(await messageCount()).toBe(4);

		// A third disallowed ask now hits daily_limit_exceeded and writes zero messages.
		const afterLimit = await call(alice, "ask", {
			to: "bob",
			category: "health",
			question: "Disallowed 3",
		});
		expect(afterLimit.isError).toBe(false);
		expect(await messageCount()).toBe(4);
		expect(unreadCount(afterLimit.text)).toBe(2);
	});
});

describe("answer", () => {
	it(`accepts ${ANSWER_MAX_LENGTH} code points and refuses one more`, async () => {
		const alice = await connect(world.alice.token);
		const bob = await connect(world.bob.token);
		const first = await askBob(alice);
		const second = await askBob(alice);
		const longest = "😀".repeat(ANSWER_MAX_LENGTH);

		const refused = await call(bob, "answer", {
			question_id: first,
			action: "answer",
			text: `${longest}a`,
		});
		expect(refused.isError).toBe(true);

		const accepted = await call(bob, "answer", {
			question_id: second,
			action: "answer",
			text: longest,
		});
		expect(accepted.isError).toBe(false);

		// The refused answer left the first question open.
		const retried = await call(bob, "answer", {
			question_id: first,
			action: "answer",
			text: longest,
		});
		expect(retried.isError).toBe(false);
	});

	it("requires text to answer and refuses text when declining", async () => {
		const alice = await connect(world.alice.token);
		const bob = await connect(world.bob.token);
		const questionId = await askBob(alice);

		const noText = await call(bob, "answer", {
			question_id: questionId,
			action: "answer",
		});
		expect(noText.isError).toBe(true);
		const declineWithText = await call(bob, "answer", {
			question_id: questionId,
			action: "decline",
			text: "no",
		});
		expect(declineWithText.isError).toBe(true);

		const declined = await call(bob, "answer", {
			question_id: questionId,
			action: "decline",
		});
		expect(declined.isError).toBe(false);
	});

	it("gives a non-recipient and an unknown ID the same text", async () => {
		const alice = await connect(world.alice.token);
		const carol = await connect(world.carol.token);
		const questionId = await askBob(alice);

		const notRecipient = await call(carol, "answer", {
			question_id: questionId,
			action: "answer",
			text: "Tuesday",
		});
		const unknown = await call(carol, "answer", {
			question_id: crypto.randomUUID(),
			action: "answer",
			text: "Tuesday",
		});
		expect(notRecipient.isError).toBe(true);
		expect(unknown.isError).toBe(true);
		expect(notRecipient.text).toBe(unknown.text);
	});

	it("refuses a second reply", async () => {
		const alice = await connect(world.alice.token);
		const bob = await connect(world.bob.token);
		const questionId = await askBob(alice);
		await call(bob, "answer", { question_id: questionId, action: "decline" });

		const again = await call(bob, "answer", {
			question_id: questionId,
			action: "answer",
			text: "Tuesday",
		});
		expect(again.isError).toBe(true);
		expect(again.text).toMatch(/already/);
	});
});
