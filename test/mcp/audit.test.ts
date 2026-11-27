import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { queryAuditLog } from "../../src/audit";
import type { McpEnv } from "../../src/mcp/config";
import { T0 } from "../helpers/fixtures";
import {
	askBob,
	call,
	connect,
	createMcpWorld,
	type McpWorld,
} from "./support";

let world: McpWorld;

beforeEach(async () => {
	world = await createMcpWorld();
});

const recordingBodies: McpEnv = {
	DB: env.DB,
	AUDIT_RECORD_BODIES: "true",
	AUDIT_BODY_RETENTION_DAYS: "30",
};

describe("audit log", () => {
	it("records every question outcome with the agents involved", async () => {
		const at = (offset: number) => ({ env: recordingBodies, now: T0 + offset });
		const alice = await connect(world.alice.token, at(0));
		const aliceLater = await connect(world.alice.token, at(1));
		const bob = await connect(world.bob.token, at(2));
		const a = world.alice.agent.id;
		const b = world.bob.agent.id;

		const answeredId = await askBob(alice, "When are you free?");
		const declinedId = await askBob(aliceLater, "Where are you?");
		const blocked = await call(aliceLater, "ask", {
			to: "bob",
			category: "health",
			question: "How is your health?",
		});
		const blockedId = /^question_id: (\S+)$/m.exec(blocked.text)?.[1];
		await call(bob, "check_inbox");
		await call(bob, "answer", {
			question_id: answeredId,
			action: "answer",
			text: "Tuesday.",
		});
		await call(bob, "answer", { question_id: declinedId, action: "decline" });
		await call(alice, "list_agents");

		const rows = await queryAuditLog(world.db, { includeBody: true });
		const shape = rows.map((row) => ({
			eventType: row.eventType,
			fromAgentId: row.fromAgentId,
			toAgentId: row.toAgentId,
			categoryId: row.categoryId,
			messageId: row.messageId,
			outcome: row.outcome,
			reasonCode: row.reasonCode,
			body: row.body,
		}));
		const schedule = world.schedule.id;
		expect(shape).toEqual([
			{
				eventType: "question_accepted",
				fromAgentId: a,
				toAgentId: b,
				categoryId: schedule,
				messageId: answeredId,
				outcome: "ok",
				reasonCode: null,
				body: "When are you free?",
			},
			{
				eventType: "question_accepted",
				fromAgentId: a,
				toAgentId: b,
				categoryId: schedule,
				messageId: declinedId,
				outcome: "ok",
				reasonCode: null,
				body: "Where are you?",
			},
			{
				eventType: "question_blocked",
				fromAgentId: a,
				toAgentId: b,
				categoryId: world.health.id,
				messageId: blockedId,
				outcome: "denied",
				reasonCode: "no_allow_rule",
				body: null,
			},
			{
				eventType: "question_delivered",
				fromAgentId: a,
				toAgentId: b,
				categoryId: schedule,
				messageId: answeredId,
				outcome: "ok",
				reasonCode: null,
				body: null,
			},
			{
				eventType: "question_delivered",
				fromAgentId: a,
				toAgentId: b,
				categoryId: schedule,
				messageId: declinedId,
				outcome: "ok",
				reasonCode: null,
				body: null,
			},
			{
				eventType: "question_answered",
				fromAgentId: a,
				toAgentId: b,
				categoryId: schedule,
				messageId: answeredId,
				outcome: "ok",
				reasonCode: null,
				body: "Tuesday.",
			},
			{
				eventType: "question_declined",
				fromAgentId: a,
				toAgentId: b,
				categoryId: schedule,
				messageId: declinedId,
				outcome: "denied",
				reasonCode: null,
				body: null,
			},
		]);
	});

	it("keeps bodies out of the log under the default settings", async () => {
		const alice = await connect(world.alice.token);
		await askBob(alice, "When are you free?");
		const rows = await queryAuditLog(world.db, { includeBody: true });
		expect(rows.map((row) => [row.eventType, row.body])).toEqual([
			["question_accepted", null],
		]);
	});

	it("records nothing for a failed answer", async () => {
		const carol = await connect(world.carol.token);
		await call(carol, "answer", {
			question_id: crypto.randomUUID(),
			action: "decline",
		});
		expect(await queryAuditLog(world.db)).toEqual([]);
	});

	it("logs question_delivered once even when recovery modes re-fetch the question", async () => {
		const alice = await connect(world.alice.token);
		const bob = await connect(world.bob.token);
		const questionId = await askBob(alice, "When are you free?");

		await call(bob, "check_inbox");
		await call(bob, "check_inbox", { mode: "pending_questions" });
		await call(bob, "check_inbox", { mode: "recent" });
		await call(bob, "check_inbox", { mode: "pending_questions" });

		const delivered = (await queryAuditLog(world.db)).filter(
			(row) => row.eventType === "question_delivered",
		);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.messageId).toBe(questionId);
	});
});
