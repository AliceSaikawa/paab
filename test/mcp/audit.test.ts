import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	ANSWER_FAILED_AUDIT_LIMIT,
	ANSWER_FAILED_AUDIT_WINDOW_MS,
	queryAuditLog,
	resetAnswerFailedAuditLimit,
} from "../../src/audit";
import { ANSWER_MAX_LENGTH, QUESTION_MAX_LENGTH } from "../../src/mcp";
import type { McpEnv } from "../../src/mcp/config";
import { DAY_MS, T0 } from "../helpers/fixtures";
import {
	askBob,
	call,
	connect,
	createMcpWorld,
	type McpWorld,
	questionIdOf,
} from "./support";

let world: McpWorld;

beforeEach(async () => {
	resetAnswerFailedAuditLimit();
	world = await createMcpWorld();
});

const recordingBodies: McpEnv = {
	DB: env.DB,
	AUDIT_RECORD_BODIES: "true",
	AUDIT_BODY_RETENTION_DAYS: "30",
};

describe("audit log", () => {
	it("records every question outcome, blocked body when opted in, and reply delivery", async () => {
		const at = (offset: number) => ({ env: recordingBodies, now: T0 + offset });
		const alice = await connect(world.alice.token, at(0));
		const aliceLater = await connect(world.alice.token, at(1));
		const bob = await connect(world.bob.token, at(2));
		const bobLater = await connect(world.bob.token, at(3));
		const aliceInbox = await connect(world.alice.token, at(4));
		const a = world.alice.agent.id;
		const b = world.bob.agent.id;

		const answeredId = await askBob(alice, "When are you free?");
		const declinedId = await askBob(aliceLater, "Where are you?");
		const blocked = await call(aliceLater, "ask", {
			to: "bob",
			category: "health",
			question: "How is your health?",
		});
		const blockedId = questionIdOf(blocked.text);
		await call(bob, "check_inbox");
		await call(bob, "answer", {
			question_id: answeredId,
			action: "answer",
			text: "Tuesday.",
		});
		await call(bobLater, "answer", {
			question_id: declinedId,
			action: "decline",
		});
		await call(aliceInbox, "check_inbox");
		await call(alice, "list_agents");

		// Blocked question bodies stay NULL in messages even when audit body recording is on.
		const blockedRow = await world.db
			.prepare("SELECT body FROM messages WHERE id = ?")
			.bind(blockedId)
			.first<{ body: string | null }>();
		expect(blockedRow?.body).toBeNull();

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
				body: "How is your health?",
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
			{
				eventType: "reply_delivered",
				fromAgentId: a,
				toAgentId: b,
				categoryId: world.health.id,
				messageId: blockedId,
				outcome: "ok",
				reasonCode: null,
				body: null,
			},
			{
				eventType: "reply_delivered",
				fromAgentId: a,
				toAgentId: b,
				categoryId: schedule,
				messageId: answeredId,
				outcome: "ok",
				reasonCode: null,
				body: null,
			},
			{
				eventType: "reply_delivered",
				fromAgentId: a,
				toAgentId: b,
				categoryId: schedule,
				messageId: declinedId,
				outcome: "ok",
				reasonCode: null,
				body: null,
			},
		]);
	});

	it("keeps bodies out of the log under the default settings for accepted and blocked questions", async () => {
		const alice = await connect(world.alice.token);
		await askBob(alice, "When are you free?");
		await call(alice, "ask", {
			to: "bob",
			category: "health",
			question: "Secret blocked question",
		});
		const rows = await queryAuditLog(world.db, { includeBody: true });
		expect(rows.map((row) => [row.eventType, row.body])).toEqual([
			["question_accepted", null],
			["question_blocked", null],
		]);
	});

	it("records reply_delivered with null target/category when a blocked question named nonexistent ones", async () => {
		const alice = await connect(world.alice.token);
		const blocked = await call(alice, "ask", {
			to: "nobody",
			category: "no-such-category",
			question: "Hello?",
		});
		const blockedId = questionIdOf(blocked.text);
		await call(alice, "check_inbox");

		const rows = await queryAuditLog(world.db);
		expect(
			rows.map((row) => ({
				eventType: row.eventType,
				fromAgentId: row.fromAgentId,
				toAgentId: row.toAgentId,
				categoryId: row.categoryId,
				messageId: row.messageId,
				outcome: row.outcome,
				reasonCode: row.reasonCode,
			})),
		).toEqual([
			{
				eventType: "question_blocked",
				fromAgentId: world.alice.agent.id,
				toAgentId: null,
				categoryId: null,
				messageId: blockedId,
				outcome: "denied",
				reasonCode: "recipient_not_found",
			},
			{
				eventType: "reply_delivered",
				fromAgentId: world.alice.agent.id,
				toAgentId: null,
				categoryId: null,
				messageId: blockedId,
				outcome: "ok",
				reasonCode: null,
			},
		]);
	});

	it("records answer_failed with the exact failure reason and normalized messageId", async () => {
		const alice = await connect(world.alice.token, { now: T0 });
		const bob = await connect(world.bob.token, { now: T0 + 1 });
		const bobExpired = await connect(world.bob.token, {
			now: T0 + 7 * DAY_MS,
		});
		const carol = await connect(world.carol.token, { now: T0 + 2 });

		const openId = await askBob(alice, "Open question");
		const expiringId = await askBob(alice, "Will expire");

		const missingId = crypto.randomUUID();
		const longId = "q".repeat(200);
		await call(carol, "answer", {
			question_id: missingId,
			action: "decline",
		});
		await call(carol, "answer", {
			question_id: "   ",
			action: "decline",
		});
		await call(carol, "answer", {
			question_id: longId,
			action: "decline",
		});
		await call(carol, "answer", {
			question_id: openId,
			action: "answer",
			text: "Not my question",
		});
		await call(bob, "answer", {
			question_id: openId,
			action: "decline",
		});
		await call(bob, "answer", {
			question_id: openId,
			action: "answer",
			text: "Duplicate reply",
		});
		await call(bobExpired, "answer", {
			question_id: expiringId,
			action: "answer",
			text: "Too late",
		});

		const failed = (await queryAuditLog(world.db, { includeBody: true }))
			.filter((row) => row.eventType === "answer_failed")
			.map((row) => ({
				fromAgentId: row.fromAgentId,
				toAgentId: row.toAgentId,
				categoryId: row.categoryId,
				messageId: row.messageId,
				outcome: row.outcome,
				reasonCode: row.reasonCode,
				body: row.body,
			}));

		expect(failed).toEqual([
			{
				fromAgentId: world.carol.agent.id,
				toAgentId: null,
				categoryId: null,
				messageId: missingId,
				outcome: "denied",
				reasonCode: "question_not_found",
				body: null,
			},
			{
				fromAgentId: world.carol.agent.id,
				toAgentId: null,
				categoryId: null,
				messageId: null,
				outcome: "denied",
				reasonCode: "question_not_found",
				body: null,
			},
			{
				fromAgentId: world.carol.agent.id,
				toAgentId: null,
				categoryId: null,
				messageId: longId.slice(0, 128),
				outcome: "denied",
				reasonCode: "question_not_found",
				body: null,
			},
			{
				fromAgentId: world.carol.agent.id,
				toAgentId: null,
				categoryId: null,
				messageId: openId,
				outcome: "denied",
				reasonCode: "not_recipient",
				body: null,
			},
			{
				fromAgentId: world.bob.agent.id,
				toAgentId: null,
				categoryId: null,
				messageId: openId,
				outcome: "denied",
				reasonCode: "question_already_replied",
				body: null,
			},
			{
				fromAgentId: world.bob.agent.id,
				toAgentId: null,
				categoryId: null,
				messageId: expiringId,
				outcome: "denied",
				reasonCode: "question_expired",
				body: null,
			},
		]);
	});

	it("records nothing for input-validation failures on ask and answer or for list_agents", async () => {
		const alice = await connect(world.alice.token);
		const bob = await connect(world.bob.token);

		expect(
			(
				await call(alice, "ask", {
					to: "bob",
					category: "schedule",
					question: "   ",
				})
			).isError,
		).toBe(true);
		expect(
			(
				await call(alice, "ask", {
					to: "bob",
					category: "schedule",
					question: "x".repeat(QUESTION_MAX_LENGTH + 1),
				})
			).isError,
		).toBe(true);
		expect(
			(
				await call(bob, "answer", {
					question_id: crypto.randomUUID(),
					action: "answer",
				})
			).isError,
		).toBe(true);
		expect(
			(
				await call(bob, "answer", {
					question_id: crypto.randomUUID(),
					action: "decline",
					text: "unexpected text",
				})
			).isError,
		).toBe(true);
		expect(
			(
				await call(bob, "answer", {
					question_id: crypto.randomUUID(),
					action: "answer",
					text: "y".repeat(ANSWER_MAX_LENGTH + 1),
				})
			).isError,
		).toBe(true);
		await call(alice, "list_agents");

		expect(await queryAuditLog(world.db)).toEqual([]);
	});

	it("bounds answer_failed audit writes per agent per isolate window without affecting tool errors or other agents", async () => {
		const carol = await connect(world.carol.token, { now: T0 });
		const bob = await connect(world.bob.token, { now: T0 + 1 });

		for (let i = 0; i < ANSWER_FAILED_AUDIT_LIMIT + 5; i++) {
			const res = await call(carol, "answer", {
				question_id: `probe-${i}`,
				action: "decline",
			});
			expect(res.isError).toBe(true);
		}

		// Another agent still gets its own audit budget in the same window.
		const bobRes = await call(bob, "answer", {
			question_id: "bob-probe",
			action: "decline",
		});
		expect(bobRes.isError).toBe(true);

		const beforeReset = await queryAuditLog(world.db);
		expect(
			beforeReset.filter(
				(row) =>
					row.eventType === "answer_failed" &&
					row.fromAgentId === world.carol.agent.id,
			),
		).toHaveLength(ANSWER_FAILED_AUDIT_LIMIT);
		expect(
			beforeReset.filter(
				(row) =>
					row.eventType === "answer_failed" &&
					row.fromAgentId === world.bob.agent.id,
			),
		).toHaveLength(1);

		// Once the window elapses, carol's failed answers are recorded again.
		const carolNextWindow = await connect(world.carol.token, {
			now: T0 + ANSWER_FAILED_AUDIT_WINDOW_MS,
		});
		await call(carolNextWindow, "answer", {
			question_id: "probe-next-window",
			action: "decline",
		});

		const afterReset = await queryAuditLog(world.db);
		expect(
			afterReset.filter(
				(row) =>
					row.eventType === "answer_failed" &&
					row.fromAgentId === world.carol.agent.id,
			),
		).toHaveLength(ANSWER_FAILED_AUDIT_LIMIT + 1);
	});
});
