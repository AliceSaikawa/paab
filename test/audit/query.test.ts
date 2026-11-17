import { beforeEach, describe, expect, it } from "vitest";
import {
	type AuditBodyConfig,
	type AuditEvent,
	type AuditLogFilter,
	type AuditLogViewRow,
	auditLogViewFromRow,
	buildAuditLogQuery,
	DEFAULT_AUDIT_QUERY_LIMIT,
	inlineAuditLogQuery,
	MAX_AUDIT_QUERY_LIMIT,
	queryAuditLog,
	recordAuditEvent,
} from "../../src/audit";
import type { Agent, Category } from "../../src/types";
import { createTestDb } from "../helpers/db";
import {
	DAY_MS,
	HOUR_MS,
	seedAgent,
	seedCategory,
	T0,
} from "../helpers/fixtures";

const RECORDING: AuditBodyConfig = {
	recordBodies: true,
	bodyRetentionDays: 30,
};

let db: D1Database;
let alice: Agent;
let bob: Agent;
let carol: Agent;
let schedule: Category;
let health: Category;

async function record(event: AuditEvent) {
	expect(await recordAuditEvent(db, RECORDING, event)).toBe(true);
}

/** The message IDs of the entries a filter returns, in order. */
async function ids(filter: AuditLogFilter): Promise<(string | null)[]> {
	return (await queryAuditLog(db, filter)).map((entry) => entry.messageId);
}

beforeEach(async () => {
	db = await createTestDb();
	alice = await seedAgent(db, { name: "alice" });
	bob = await seedAgent(db, { name: "bob" });
	carol = await seedAgent(db, { name: "carol's bot" });
	schedule = await seedCategory(db, { name: "schedule" });
	health = await seedCategory(db, { name: "health" });

	await record({
		occurredAt: T0,
		eventType: "question_accepted",
		fromAgentId: alice.id,
		toAgentId: bob.id,
		categoryId: schedule.id,
		messageId: "q1",
		body: "body of q1",
	});
	await record({
		occurredAt: T0 + HOUR_MS,
		eventType: "question_blocked",
		reasonCode: "no_allow_rule",
		fromAgentId: bob.id,
		toAgentId: alice.id,
		categoryId: health.id,
		messageId: "q2",
	});
	await record({
		occurredAt: T0 + DAY_MS,
		eventType: "question_expired",
		fromAgentId: alice.id,
		toAgentId: carol.id,
		categoryId: health.id,
		messageId: "q3",
	});
	await record({
		occurredAt: T0 + 2 * DAY_MS,
		eventType: "auth_failed",
		reasonCode: "token_unknown",
		messageId: "q4",
	});
});

describe("queryAuditLog", () => {
	it("returns everything in time order without a filter", async () => {
		expect(await ids({})).toEqual(["q1", "q2", "q3", "q4"]);
	});

	it("orders by time first and by ID within the same time", async () => {
		await record({
			occurredAt: T0 - 1,
			eventType: "question_delivered",
			messageId: "early",
		});
		await record({
			occurredAt: T0,
			eventType: "question_delivered",
			messageId: "tie",
		});

		expect(await ids({})).toEqual(["early", "q1", "tie", "q2", "q3", "q4"]);
	});

	it("filters by period: start inclusive, end exclusive", async () => {
		expect(await ids({ occurredFrom: T0 + HOUR_MS })).toEqual([
			"q2",
			"q3",
			"q4",
		]);
		expect(await ids({ occurredBefore: T0 + DAY_MS })).toEqual(["q1", "q2"]);
		expect(
			await ids({
				occurredFrom: T0 + HOUR_MS,
				occurredBefore: T0 + 2 * DAY_MS,
			}),
		).toEqual(["q2", "q3"]);
	});

	it("filters by sender, by ID and by name", async () => {
		expect(await ids({ fromAgentId: alice.id })).toEqual(["q1", "q3"]);
		expect(await ids({ fromAgentName: "alice" })).toEqual(["q1", "q3"]);
		expect(await ids({ fromAgentName: "bob" })).toEqual(["q2"]);
		expect(await ids({ fromAgentName: "nobody" })).toEqual([]);
	});

	it("filters by recipient, by ID and by name", async () => {
		expect(await ids({ toAgentId: bob.id })).toEqual(["q1"]);
		expect(await ids({ toAgentName: "alice" })).toEqual(["q2"]);
		expect(await ids({ toAgentName: "carol's bot" })).toEqual(["q3"]);
	});

	it("filters by category, by ID and by name", async () => {
		expect(await ids({ categoryId: health.id })).toEqual(["q2", "q3"]);
		expect(await ids({ categoryName: "schedule" })).toEqual(["q1"]);
		expect(await ids({ categoryName: "unknown" })).toEqual([]);
	});

	it("filters by outcome", async () => {
		expect(await ids({ outcome: "ok" })).toEqual(["q1"]);
		expect(await ids({ outcome: "denied" })).toEqual(["q2", "q4"]);
		expect(await ids({ outcome: "expired" })).toEqual(["q3"]);
	});

	it("combines conditions with AND", async () => {
		expect(
			await ids({ fromAgentName: "alice", categoryName: "health" }),
		).toEqual(["q3"]);
		expect(await ids({ fromAgentName: "alice", outcome: "denied" })).toEqual(
			[],
		);
	});

	it("limits the number of entries, oldest first", async () => {
		expect(await ids({ limit: 2 })).toEqual(["q1", "q2"]);
		expect(await ids({ outcome: "denied", limit: 1 })).toEqual(["q2"]);
	});

	it("returns current names, and null for what has no name", async () => {
		const entries = await queryAuditLog(db);
		expect(entries[0]).toMatchObject({
			fromAgentName: "alice",
			toAgentName: "bob",
			categoryName: "schedule",
		});
		expect(entries[3]).toMatchObject({
			fromAgentId: null,
			fromAgentName: null,
			toAgentName: null,
			categoryName: null,
		});
	});

	it("still finds entries of a deleted agent by ID", async () => {
		await db.prepare("DELETE FROM agents WHERE id = ?").bind(carol.id).run();

		const entries = await queryAuditLog(db, { toAgentId: carol.id });
		expect(entries.map((entry) => entry.messageId)).toEqual(["q3"]);
		expect(entries[0]?.toAgentName).toBeNull();
		expect(await ids({ toAgentName: "carol's bot" })).toEqual([]);
	});

	it("hides bodies unless asked for them", async () => {
		expect((await queryAuditLog(db))[0]?.body).toBeNull();
		expect((await queryAuditLog(db, { includeBody: true }))[0]?.body).toBe(
			"body of q1",
		);
	});

	it("rejects a malformed filter", async () => {
		await expect(queryAuditLog(db, { limit: 0 })).rejects.toThrow(RangeError);
	});
});

describe("buildAuditLogQuery", () => {
	it("builds SQL and bind values without a database", () => {
		const query = buildAuditLogQuery({
			occurredFrom: T0,
			occurredBefore: T0 + DAY_MS,
			fromAgentName: "alice",
			toAgentId: "id-b",
			categoryName: "schedule",
			outcome: "denied",
			limit: 5,
		});

		expect(query.sql).toContain(
			"WHERE l.occurred_at >= ? AND l.occurred_at < ? AND fa.name = ? AND l.to_agent_id = ? AND c.name = ? AND l.outcome = ?",
		);
		expect(query.sql).toMatch(/ORDER BY l\.occurred_at, l\.id LIMIT \?$/);
		expect(query.params).toEqual([
			T0,
			T0 + DAY_MS,
			"alice",
			"id-b",
			"schedule",
			"denied",
			5,
		]);
	});

	it("applies the default limit and caps a large one", () => {
		expect(buildAuditLogQuery().params).toEqual([DEFAULT_AUDIT_QUERY_LIMIT]);
		expect(buildAuditLogQuery({ limit: 1_000_000 }).params).toEqual([
			MAX_AUDIT_QUERY_LIMIT,
		]);
	});

	it.each([
		["a zero limit", { limit: 0 }],
		["a fractional limit", { limit: 1.5 }],
		["a time that is not an integer", { occurredFrom: Number.NaN }],
		["an unknown outcome", { outcome: "maybe" }],
		["an empty name", { fromAgentName: "" }],
	])("throws on %s", (_name, filter) => {
		expect(() => buildAuditLogQuery(filter as AuditLogFilter)).toThrow(
			RangeError,
		);
	});
});

describe("inlineAuditLogQuery", () => {
	async function run(filter: AuditLogFilter) {
		const sql = inlineAuditLogQuery(buildAuditLogQuery(filter));
		const { results } = await db.prepare(sql).all<AuditLogViewRow>();
		return results.map(auditLogViewFromRow).map((entry) => entry.messageId);
	}

	it("returns the same entries as the bound query", async () => {
		const filter: AuditLogFilter = {
			occurredFrom: T0,
			fromAgentName: "alice",
			outcome: "expired",
			limit: 10,
		};
		expect(await run(filter)).toEqual(await ids(filter));
		expect(await run(filter)).toEqual(["q3"]);
	});

	it("escapes quotes in text values", async () => {
		expect(await run({ toAgentName: "carol's bot" })).toEqual(["q3"]);
		expect(await run({ fromAgentName: "x' OR '1'='1" })).toEqual([]);
		expect(await ids({})).toHaveLength(4);
	});

	it("rejects values it cannot write safely", () => {
		expect(() =>
			inlineAuditLogQuery(buildAuditLogQuery({ fromAgentName: "a\0b" })),
		).toThrow(RangeError);
		expect(() =>
			inlineAuditLogQuery({ sql: "SELECT ?", params: [] }),
		).toThrow();
	});
});
