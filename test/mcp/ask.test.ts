import { beforeEach, describe, expect, it } from "vitest";
import { queryAuditLog } from "../../src/audit";
import { ANSWER_MAX_LENGTH, QUESTION_MAX_LENGTH } from "../../src/mcp";
import {
	askBob,
	call,
	connect,
	createMcpWorld,
	type McpWorld,
	questionIdOf,
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
		expect(await queryAuditLog(world.db)).toEqual([]);
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
