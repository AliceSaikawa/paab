import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_MS, HOUR_MS, T0 } from "../helpers/fixtures";
import { call, questionIdOf, withoutFooter } from "../mcp/support";
import {
	ANSWER,
	auditLog,
	type Bridge,
	connect,
	inboxMessages,
	maskIds,
	QUESTION,
	runCron,
	SEED,
	startBridge,
} from "./support";

let alice: Client;
let bob: Client;

async function connectBoth(bridge: Bridge): Promise<void> {
	alice = await connect(bridge, "alice");
	bob = await connect(bridge, "bob");
}

async function ask(
	client: Client,
	to: string,
	category: string,
): Promise<string> {
	const result = await call(client, "ask", {
		to,
		category,
		question: QUESTION,
	});
	expect(result.isError).toBe(false);
	return questionIdOf(result.text);
}

async function inbox(client: Client): Promise<string[]> {
	return inboxMessages((await call(client, "check_inbox")).text);
}

function rejectionOf(questionId: string): string {
	return expect.stringMatching(
		new RegExp(
			`^kind: rejection\nmessage_id: \\S+\nquestion_id: ${questionId}$`,
		),
	);
}

// The Worker reads the clock itself, so the tests move the clock instead of
// passing a time in.
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"], now: T0 });
	await connectBoth(await startBridge());
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a question and its answer", () => {
	it("travel from alice to bob and back, and leave an audit trail without bodies", async () => {
		const agents = await call(alice, "list_agents");
		expect(agents.text).toContain("agents: 1");
		expect(agents.text).toContain("name: bob\ncategories: 予定\n");
		expect(agents.text).toContain(SEED.agents[1]?.description);

		const questionId = await ask(alice, "bob", "予定");

		const [question, ...otherQuestions] = await inbox(bob);
		expect(otherQuestions).toEqual([]);
		expect(question).toContain(
			`kind: question\nmessage_id: ${questionId}\nquestion_id: ${questionId}\nfrom: alice\ncategory: 予定\n`,
		);
		expect(question).toContain(QUESTION);

		const answered = await call(bob, "answer", {
			question_id: questionId,
			action: "answer",
			text: ANSWER,
		});
		expect(answered.isError).toBe(false);

		const [reply, ...otherReplies] = await inbox(alice);
		expect(otherReplies).toEqual([]);
		expect(reply).toMatch(/^kind: answer\nmessage_id: \S+\n/);
		expect(reply).toContain(
			`question_id: ${questionId}\nfrom: bob\ncategory: 予定\n`,
		);
		expect(reply).toContain(ANSWER);
		expect(await inbox(alice)).toEqual([]);

		const log = await auditLog();
		expect(
			log.map((entry) => [
				entry.eventType,
				entry.fromAgentName,
				entry.toAgentName,
				entry.categoryName,
				entry.outcome,
				entry.messageId,
			]),
		).toEqual([
			["question_accepted", "alice", "bob", "予定", "ok", questionId],
			["question_delivered", "alice", "bob", "予定", "ok", questionId],
			["question_answered", "alice", "bob", "予定", "ok", questionId],
		]);
		expect(log.map((entry) => entry.body)).toEqual([null, null, null]);
		expect(JSON.stringify(log)).not.toContain(QUESTION);
		expect(JSON.stringify(log)).not.toContain(ANSWER);
	});
});

describe("a question the bridge does not allow", () => {
	it("in a category without a rule never reaches bob, and alice gets a rejection", async () => {
		const questionId = await ask(alice, "bob", "健康");

		expect(await inbox(bob)).toEqual([]);
		expect(await inbox(alice)).toEqual([rejectionOf(questionId)]);
		expect(await auditLog()).toMatchObject([
			{
				eventType: "question_blocked",
				fromAgentName: "alice",
				toAgentName: "bob",
				categoryName: "健康",
				outcome: "denied",
				reasonCode: "no_allow_rule",
			},
		]);
	});

	it("from bob to alice never reaches alice without a rule in that direction", async () => {
		const questionId = await ask(bob, "alice", "予定");

		expect(await inbox(alice)).toEqual([]);
		expect(await inbox(bob)).toEqual([rejectionOf(questionId)]);
	});

	it("over the daily limit never reaches bob and suppresses repeated writes", async () => {
		const limit = 2;
		await connectBoth(
			await startBridge({
				...SEED,
				agents: SEED.agents.map((agent) => ({
					...agent,
					dailyQuestionLimit: limit,
				})),
			}),
		);

		const first = await ask(alice, "bob", "予定");
		const second = await ask(alice, "bob", "予定");
		const overLimit = await ask(alice, "bob", "予定");
		const overLimitAgain = await ask(alice, "bob", "予定");
		expect(overLimitAgain).not.toBe(overLimit);

		const delivered = (await inbox(bob)).map(questionIdOf);
		expect(delivered.sort()).toEqual([first, second].sort());
		expect(await inbox(alice)).toEqual([]);
		const limitAudits = (await auditLog()).filter(
			(entry) =>
				entry.eventType === "question_blocked" &&
				entry.reasonCode === "daily_limit_exceeded",
		);
		expect(limitAudits).toHaveLength(1);
		expect(limitAudits[0]).toMatchObject({
			eventType: "question_blocked",
			reasonCode: "daily_limit_exceeded",
			messageId: overLimit,
		});

		vi.setSystemTime(T0 + DAY_MS);
		const nextDay = await ask(alice, "bob", "予定");
		expect(await inbox(bob)).toEqual([
			expect.stringContaining(`question_id: ${nextDay}\n`),
		]);
	});
});

describe("a rejection", () => {
	it("reads the same to alice whether bob declined or the bridge blocked the question", async () => {
		const toDecline = await call(alice, "ask", {
			to: "bob",
			category: "予定",
			question: QUESTION,
		});
		const toBlock = await call(alice, "ask", {
			to: "bob",
			category: "健康",
			question: QUESTION,
		});
		expect(maskIds(withoutFooter(toBlock.text))).toBe(
			maskIds(withoutFooter(toDecline.text)),
		);
		expect(toBlock.isError).toBe(toDecline.isError);

		const declined = await call(bob, "answer", {
			question_id: questionIdOf(toDecline.text),
			action: "decline",
		});
		expect(declined.isError).toBe(false);

		const received = await call(alice, "check_inbox");
		const rejections = inboxMessages(received.text);
		expect(rejections).toHaveLength(2);
		expect(
			rejections.map((rejection) => rejection.split("\n")[2]).sort(),
		).toEqual(
			[
				`question_id: ${questionIdOf(toDecline.text)}`,
				`question_id: ${questionIdOf(toBlock.text)}`,
			].sort(),
		);
		const [one, other] = rejections.map(maskIds);
		expect(one).toBe("kind: rejection\nmessage_id: *\nquestion_id: *");
		expect(other).toBe(one);
		expect(received.text).not.toContain("bob");
		expect(received.text).not.toContain("予定");
		expect(received.text).not.toContain("健康");
	});
});

describe("answering", () => {
	it("is refused for alice on a question addressed to bob", async () => {
		const questionId = await ask(alice, "bob", "予定");

		const stolen = await call(alice, "answer", {
			question_id: questionId,
			action: "answer",
			text: "alice wrote this",
		});
		const unknown = await call(alice, "answer", {
			question_id: "no-such-question",
			action: "answer",
			text: "alice wrote this",
		});
		expect(stolen.isError).toBe(true);
		expect(withoutFooter(stolen.text)).toBe(withoutFooter(unknown.text));

		const answered = await call(bob, "answer", {
			question_id: questionId,
			action: "answer",
			text: ANSWER,
		});
		expect(answered.isError).toBe(false);
		const [reply, ...others] = await inbox(alice);
		expect(others).toEqual([]);
		expect(reply).toContain(ANSWER);
		expect(reply).not.toContain("alice wrote this");
	});

	it("is refused after seven days, and alice gets a rejection", async () => {
		const questionId = await ask(alice, "bob", "予定");
		expect(await inbox(bob)).toHaveLength(1);

		vi.setSystemTime(T0 + 7 * DAY_MS - HOUR_MS);
		await runCron();
		expect(await inbox(alice)).toEqual([]);

		vi.setSystemTime(T0 + 7 * DAY_MS);
		const late = await call(bob, "answer", {
			question_id: questionId,
			action: "answer",
			text: ANSWER,
		});
		expect(late.isError).toBe(true);
		expect(late.text).toContain("expired");

		await runCron();
		expect(await inbox(alice)).toEqual([rejectionOf(questionId)]);
		expect(await auditLog()).toContainEqual(
			expect.objectContaining({
				eventType: "question_expired",
				fromAgentName: "alice",
				toAgentName: "bob",
				categoryName: "予定",
				outcome: "expired",
				messageId: questionId,
			}),
		);
	});
});
