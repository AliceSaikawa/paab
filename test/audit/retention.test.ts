import { beforeEach, describe, expect, it } from "vitest";
import {
	AUDIT_BODY_RECORDING_DISABLED,
	type AuditBodyConfig,
	purgeExpiredAuditBodies,
	recordAuditEvent,
} from "../../src/audit";
import { createTestDb } from "../helpers/db";
import { DAY_MS, T0 } from "../helpers/fixtures";

const RECORDING: AuditBodyConfig = {
	recordBodies: true,
	bodyRetentionDays: 30,
};

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
});

async function record(occurredAt: number, messageId: string) {
	await recordAuditEvent(db, RECORDING, {
		occurredAt,
		eventType: "question_accepted",
		fromAgentId: "agent-a",
		toAgentId: "agent-b",
		categoryId: "category-1",
		messageId,
		body: `body of ${messageId}`,
	});
}

async function bodies(): Promise<Record<string, string | null>> {
	const { results } = await db
		.prepare("SELECT message_id, body FROM audit_log ORDER BY id")
		.all<{ message_id: string; body: string | null }>();
	return Object.fromEntries(results.map((row) => [row.message_id, row.body]));
}

describe("purgeExpiredAuditBodies", () => {
	it("removes a body once its retention period has passed, and keeps the entry", async () => {
		await record(T0, "old");
		await record(T0 + 1, "newer");

		expect(
			await purgeExpiredAuditBodies(db, RECORDING, T0 + 30 * DAY_MS - 1),
		).toBe(0);
		expect(await bodies()).toEqual({
			old: "body of old",
			newer: "body of newer",
		});

		expect(await purgeExpiredAuditBodies(db, RECORDING, T0 + 30 * DAY_MS)).toBe(
			1,
		);
		expect(await bodies()).toEqual({ old: null, newer: "body of newer" });

		// Already purged entries are not counted again.
		expect(await purgeExpiredAuditBodies(db, RECORDING, T0 + 30 * DAY_MS)).toBe(
			0,
		);
	});

	it("follows the configured number of days", async () => {
		await record(T0, "q");

		expect(
			await purgeExpiredAuditBodies(
				db,
				{ recordBodies: true, bodyRetentionDays: 1 },
				T0 + DAY_MS,
			),
		).toBe(1);
		expect(await bodies()).toEqual({ q: null });
	});

	it("removes every remaining body while recording is disabled", async () => {
		await record(T0, "q1");
		await record(T0 + DAY_MS, "q2");

		expect(
			await purgeExpiredAuditBodies(
				db,
				AUDIT_BODY_RECORDING_DISABLED,
				T0 + DAY_MS,
			),
		).toBe(2);
		expect(await bodies()).toEqual({ q1: null, q2: null });
	});

	it("purges bodies recorded on question_blocked entries on the same schedule", async () => {
		await recordAuditEvent(db, RECORDING, {
			occurredAt: T0,
			eventType: "question_blocked",
			fromAgentId: "agent-a",
			toAgentId: "agent-b",
			categoryId: "category-1",
			reasonCode: "no_allow_rule",
			messageId: "blocked-1",
			body: "blocked secret question",
		});

		expect(
			await purgeExpiredAuditBodies(db, RECORDING, T0 + 30 * DAY_MS - 1),
		).toBe(0);
		expect(await bodies()).toEqual({ "blocked-1": "blocked secret question" });

		expect(await purgeExpiredAuditBodies(db, RECORDING, T0 + 30 * DAY_MS)).toBe(
			1,
		);
		expect(await bodies()).toEqual({ "blocked-1": null });
	});
});
