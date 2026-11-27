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
	});

	it("enforces daily_question_limit atomically across concurrent ask calls", async () => {
		await world.db
			.prepare("UPDATE agents SET daily_question_limit = 2 WHERE id = ?")
			.bind(world.alice.agent.id)
			.run();

		const alice = await connect(world.alice.token);
		const bob = await connect(world.bob.token);

		const initialId = await askBob(alice, "First question");

		const concurrentResults = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				call(alice, "ask", {
					to: "bob",
					category: "schedule",
					question: `Concurrent question ${i}`,
				}),
			),
		);
		for (const res of concurrentResults) {
			expect(res.isError).toBe(false);
		}
		const concurrentIds = concurrentResults.map((res) =>
			questionIdOf(res.text),
		);

		const { results: questionRows } = await world.db
			.prepare(
				"SELECT id, status, body FROM messages WHERE kind = 'question' AND from_agent_id = ?",
			)
			.bind(world.alice.agent.id)
			.all<{ id: string; status: string; body: string | null }>();

		const pending = questionRows.filter((row) => row.status === "pending");
		const blocked = questionRows.filter((row) => row.status === "blocked");
		expect(pending).toHaveLength(2);
		expect(pending.map((row) => row.id)).toContain(initialId);
		expect(blocked).toHaveLength(4);
		for (const row of blocked) {
			expect(row.body).toBeNull();
			expect(concurrentIds).toContain(row.id);
		}

		const bobInbox = await call(bob, "check_inbox");
		expect(bobInbox.text).toContain("messages: 2");

		const aliceInbox = await call(alice, "check_inbox");
		expect(aliceInbox.text).toContain("messages: 4");
		for (const row of blocked) {
			expect(aliceInbox.text).toContain(`question_id: ${row.id}`);
		}

		const audits = await queryAuditLog(world.db);
		const concurrentAudits = audits.filter(
			(entry) =>
				entry.messageId !== null && concurrentIds.includes(entry.messageId),
		);
		expect(
			concurrentAudits.filter(
				(entry) => entry.eventType === "question_accepted",
			),
		).toHaveLength(1);
		const blockedAudits = concurrentAudits.filter(
			(entry) => entry.eventType === "question_blocked",
		);
		expect(blockedAudits).toHaveLength(4);
		for (const entry of blockedAudits) {
			expect(entry.reasonCode).toBe("daily_limit_exceeded");
		}
	});

	it("blocks every concurrent ask call when daily_question_limit is 0", async () => {
		await world.db
			.prepare("UPDATE agents SET daily_question_limit = 0 WHERE id = ?")
			.bind(world.alice.agent.id)
			.run();

		const alice = await connect(world.alice.token);
		const bob = await connect(world.bob.token);

		const results = await Promise.all(
			Array.from({ length: 3 }, (_, i) =>
				call(alice, "ask", {
					to: "bob",
					category: "schedule",
					question: `Zero-limit question ${i}`,
				}),
			),
		);
		for (const res of results) {
			expect(res.isError).toBe(false);
		}
		const ids = results.map((res) => questionIdOf(res.text));

		const { results: questionRows } = await world.db
			.prepare(
				"SELECT id, status FROM messages WHERE kind = 'question' AND from_agent_id = ?",
			)
			.bind(world.alice.agent.id)
			.all<{ id: string; status: string }>();
		expect(questionRows.filter((row) => row.status === "pending")).toHaveLength(
			0,
		);
		expect(questionRows.filter((row) => row.status === "blocked")).toHaveLength(
			3,
		);

		const bobInbox = await call(bob, "check_inbox");
		expect(bobInbox.text).toContain("no new messages");

		const aliceInbox = await call(alice, "check_inbox");
		expect(aliceInbox.text).toContain("messages: 3");
		for (const id of ids) {
			expect(aliceInbox.text).toContain(`question_id: ${id}`);
		}

		const audits = await queryAuditLog(world.db);
		expect(audits).toHaveLength(3);
		for (const entry of audits) {
			expect(entry.eventType).toBe("question_blocked");
			expect(entry.reasonCode).toBe("daily_limit_exceeded");
		}
	});

	it("preserves reason-code precedence when already at daily_question_limit", async () => {
		await world.db
			.prepare("UPDATE agents SET daily_question_limit = 1 WHERE id = ?")
			.bind(world.alice.agent.id)
			.run();

		const alice = await connect(world.alice.token);
		await askBob(alice, "Consumes daily quota");

		const noRuleId = questionIdOf(
			(
				await call(alice, "ask", {
					to: "bob",
					category: "health",
					question: "No rule",
				})
			).text,
		);
		const missingRecipientId = questionIdOf(
			(
				await call(alice, "ask", {
					to: "nobody",
					category: "schedule",
					question: "Missing recipient",
				})
			).text,
		);
		const overLimitId = questionIdOf(
			(
				await call(alice, "ask", {
					to: "bob",
					category: "schedule",
					question: "Over limit",
				})
			).text,
		);

		const audits = await queryAuditLog(world.db);
		const reasonByMessage = new Map(
			audits.map((entry) => [entry.messageId, entry.reasonCode]),
		);
		expect(reasonByMessage.get(noRuleId)).toBe("no_allow_rule");
		expect(reasonByMessage.get(missingRecipientId)).toBe("recipient_not_found");
		expect(reasonByMessage.get(overLimitId)).toBe("daily_limit_exceeded");
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
