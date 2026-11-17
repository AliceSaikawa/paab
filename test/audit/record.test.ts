import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUDIT_BODY_RECORDING_DISABLED,
	type AuditBodyConfig,
	type AuditEvent,
	queryAuditLog,
	recordAuditEvent,
} from "../../src/audit";
import type { AuditLogRow } from "../../src/db";
import { AUDIT_EVENT_TYPES } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { T0 } from "../helpers/fixtures";

const RECORDING: AuditBodyConfig = {
	recordBodies: true,
	bodyRetentionDays: 30,
};
const BODY = "When is the dentist appointment?";

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function storedRows(): Promise<AuditLogRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM audit_log ORDER BY id")
		.all<AuditLogRow>();
	return results;
}

const question = {
	fromAgentId: "agent-a",
	toAgentId: "agent-b",
	categoryId: "category-schedule",
	messageId: "question-1",
};

describe("recordAuditEvent", () => {
	const cases: { event: AuditEvent; outcome: string; reason: string | null }[] =
		[
			{
				event: { ...question, occurredAt: T0, eventType: "question_accepted" },
				outcome: "ok",
				reason: null,
			},
			{
				event: {
					...question,
					occurredAt: T0 + 1,
					eventType: "question_blocked",
					reasonCode: "no_allow_rule",
				},
				outcome: "denied",
				reason: "no_allow_rule",
			},
			{
				event: {
					...question,
					occurredAt: T0 + 2,
					eventType: "question_delivered",
				},
				outcome: "ok",
				reason: null,
			},
			{
				event: {
					...question,
					occurredAt: T0 + 3,
					eventType: "question_answered",
				},
				outcome: "ok",
				reason: null,
			},
			{
				event: {
					...question,
					occurredAt: T0 + 4,
					eventType: "question_declined",
				},
				outcome: "denied",
				reason: null,
			},
			{
				event: {
					...question,
					occurredAt: T0 + 5,
					eventType: "question_expired",
				},
				outcome: "expired",
				reason: null,
			},
			{
				event: {
					occurredAt: T0 + 6,
					eventType: "auth_failed",
					reasonCode: "token_unknown",
				},
				outcome: "denied",
				reason: "token_unknown",
			},
		];

	it("has a case for every event type", () => {
		expect(cases.map((c) => c.event.eventType).sort()).toEqual(
			[...AUDIT_EVENT_TYPES].sort(),
		);
	});

	it.each(cases)(
		"records and reads back $event.eventType",
		async ({ event, outcome, reason }) => {
			expect(
				await recordAuditEvent(db, AUDIT_BODY_RECORDING_DISABLED, event),
			).toBe(true);

			const entries = await queryAuditLog(db);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				occurredAt: event.occurredAt,
				eventType: event.eventType,
				fromAgentId: event.fromAgentId ?? null,
				toAgentId: event.toAgentId ?? null,
				categoryId: event.categoryId ?? null,
				messageId: event.messageId ?? null,
				outcome,
				reasonCode: reason,
			});
		},
	);

	it("leaves the body column empty by default", async () => {
		await recordAuditEvent(db, AUDIT_BODY_RECORDING_DISABLED, {
			...question,
			occurredAt: T0,
			eventType: "question_accepted",
			body: BODY,
		});

		const rows = await storedRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.body).toBeNull();
	});

	it("leaves the body column empty when recording is on without a retention period", async () => {
		await recordAuditEvent(
			db,
			{ recordBodies: true, bodyRetentionDays: 0 },
			{
				...question,
				occurredAt: T0,
				eventType: "question_accepted",
				body: BODY,
			},
		);

		expect((await storedRows())[0]?.body).toBeNull();
	});

	it("stores the body when recording is enabled", async () => {
		await recordAuditEvent(db, RECORDING, {
			...question,
			occurredAt: T0,
			eventType: "question_accepted",
			body: BODY,
		});
		await recordAuditEvent(db, RECORDING, {
			...question,
			occurredAt: T0 + 1,
			eventType: "question_delivered",
		});

		const rows = await storedRows();
		expect(rows.map((row) => row.body)).toEqual([BODY, null]);
	});

	describe("when the write fails", () => {
		const SECRET_BODY = "my card number is 4111";

		function failingDb(message: string): D1Database {
			return {
				prepare() {
					throw new Error(message);
				},
			} as unknown as D1Database;
		}

		it("resolves to false instead of throwing, and reports on the console", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});

			const result = await recordAuditEvent(
				failingDb("D1 is down"),
				RECORDING,
				{
					...question,
					occurredAt: T0,
					eventType: "question_accepted",
					body: SECRET_BODY,
				},
			);

			expect(result).toBe(false);
			expect(error).toHaveBeenCalledTimes(1);
			expect(error.mock.calls[0]?.[1]).toMatchObject({
				eventType: "question_accepted",
				messageId: "question-1",
				error: "D1 is down",
			});
		});

		it("keeps the body out of the console", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});

			await recordAuditEvent(
				failingDb(`cannot store ${SECRET_BODY}`),
				RECORDING,
				{
					...question,
					occurredAt: T0,
					eventType: "question_accepted",
					body: SECRET_BODY,
				},
			);

			expect(JSON.stringify(error.mock.calls)).not.toContain(SECRET_BODY);
		});

		it("resolves to false when the statement rejects", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const rejectingDb = {
				prepare: () => ({
					bind: () => ({
						run: () => Promise.reject(new Error("D1_ERROR: no such table")),
					}),
				}),
			} as unknown as D1Database;

			expect(
				await recordAuditEvent(rejectingDb, AUDIT_BODY_RECORDING_DISABLED, {
					...question,
					occurredAt: T0,
					eventType: "question_accepted",
				}),
			).toBe(false);
			expect(error).toHaveBeenCalledTimes(1);
		});

		it.each([
			["an unknown event type", { eventType: "rule_changed" }],
			["an unknown reason code", { reasonCode: "because" }],
			["a time that is not an integer", { occurredAt: Number.NaN }],
		])("does not write %s", async (_name, override) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const event = {
				...question,
				occurredAt: T0,
				eventType: "question_blocked",
				reasonCode: "no_allow_rule",
				...override,
			} as unknown as AuditEvent;

			expect(
				await recordAuditEvent(db, AUDIT_BODY_RECORDING_DISABLED, event),
			).toBe(false);
			expect(await storedRows()).toEqual([]);
			expect(error).toHaveBeenCalledTimes(1);
		});
	});
});
