import { beforeEach, describe, expect, it } from "vitest";
import {
	AUDIT_BODY_RECORDING_DISABLED,
	type AuditBodyConfig,
	DEFAULT_AUDIT_LOG_RETENTION_DAYS,
	purgeExpiredAuditBodies,
	purgeExpiredAuditLogs,
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
});

describe("purgeExpiredAuditLogs", () => {
	async function messageIds(): Promise<string[]> {
		const { results } = await db
			.prepare("SELECT message_id FROM audit_log ORDER BY id")
			.all<{ message_id: string }>();
		return results.map((row) => row.message_id);
	}

	it("deletes rows at the default 365-day boundary and keeps newer rows", async () => {
		expect(DEFAULT_AUDIT_LOG_RETENTION_DAYS).toBe(365);
		await record(T0, "old");
		await record(T0 + 1, "newer");

		const justBefore = T0 + 365 * DAY_MS - 1;
		expect(await purgeExpiredAuditLogs(db, justBefore)).toBe(0);
		expect(await messageIds()).toEqual(["old", "newer"]);

		const atCutoff = T0 + 365 * DAY_MS;
		expect(await purgeExpiredAuditLogs(db, atCutoff)).toBe(1);
		expect(await messageIds()).toEqual(["newer"]);

		// Idempotent on repeat run.
		expect(await purgeExpiredAuditLogs(db, atCutoff)).toBe(0);
	});

	it("respects a custom positive retention period", async () => {
		await record(T0, "old");
		await record(T0 + DAY_MS, "keep");

		expect(await purgeExpiredAuditLogs(db, T0 + 90 * DAY_MS - 1, 90)).toBe(0);
		expect(await purgeExpiredAuditLogs(db, T0 + 90 * DAY_MS, 90)).toBe(1);
		expect(await messageIds()).toEqual(["keep"]);
	});

	it("retains rows indefinitely when retentionDays is 0 or invalid", async () => {
		await record(T0, "ancient");
		const tenYearsLater = T0 + 3650 * DAY_MS;

		for (const days of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
			expect(await purgeExpiredAuditLogs(db, tenYearsLater, days)).toBe(0);
		}
		expect(await messageIds()).toEqual(["ancient"]);
	});
});
