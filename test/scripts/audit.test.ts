import { beforeEach, describe, expect, it } from "vitest";
import {
	auditLogFilter,
	formatAuditLog,
	formatTime,
	parseTime,
	readAuditLog,
} from "../../scripts/lib/audit";
import {
	CliError,
	parseWranglerRows,
	wranglerFailure,
} from "../../scripts/lib/sql";
import { queryAuditLog, recordAuditEvent } from "../../src/audit";
import type { Agent, Category } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { HOUR_MS, seedAgent, seedCategory, T0 } from "../helpers/fixtures";
import { d1Client } from "./support";

let db: D1Database;
let muse: Agent;
let grok: Agent;
let schedule: Category;

beforeEach(async () => {
	db = await createTestDb();
	muse = await seedAgent(db, { name: "muse" });
	grok = await seedAgent(db, { name: "grok" });
	schedule = await seedCategory(db, { name: "予定" });
	const config = { recordBodies: true, bodyRetentionDays: 30 };
	await recordAuditEvent(db, config, {
		occurredAt: T0,
		eventType: "question_accepted",
		fromAgentId: muse.id,
		toAgentId: grok.id,
		categoryId: schedule.id,
		messageId: "q1",
		body: "明日の\t予定は？",
	});
	await recordAuditEvent(db, config, {
		occurredAt: T0 + HOUR_MS,
		eventType: "question_blocked",
		reasonCode: "no_allow_rule",
		fromAgentId: grok.id,
		toAgentId: muse.id,
		categoryId: schedule.id,
		messageId: "q2",
	});
	await recordAuditEvent(db, config, {
		occurredAt: T0 + 2 * HOUR_MS,
		eventType: "auth_failed",
		reasonCode: "token_unknown",
	});
});

describe("auditLogFilter", () => {
	it("maps every option onto the shared filter", () => {
		expect(
			auditLogFilter({
				since: "2026-11-16T09:00+09:00",
				before: "2026-11-17T00:00Z",
				from: "muse",
				to: "grok",
				category: "予定",
				outcome: "denied",
				limit: "5",
				body: true,
			}),
		).toEqual({
			occurredFrom: T0,
			occurredBefore: T0 + 24 * HOUR_MS,
			fromAgentName: "muse",
			toAgentName: "grok",
			categoryName: "予定",
			outcome: "denied",
			limit: 5,
			includeBody: true,
			order: "desc",
		});
	});

	it("reads the log newest first unless --oldest is given", () => {
		expect(auditLogFilter({}).order).toBe("desc");
		expect(auditLogFilter({ oldest: true })).toEqual({
			includeBody: false,
			order: "asc",
		});
	});

	it("maps the cursor options", () => {
		expect(auditLogFilter({ afterId: "10", beforeId: "20" })).toMatchObject({
			afterId: 10,
			beforeId: 20,
		});
	});

	it.each([
		[{ since: "2026-11-16 09:00" }, "--since"],
		[{ before: "2026-11-16T09:00" }, "--before"],
		[{ outcome: "error" }, "--outcome"],
		[{ limit: "0" }, "--limit"],
		[{ limit: "ten" }, "--limit"],
		[{ afterId: "-1" }, "--after-id"],
		[{ beforeId: "soon" }, "--before-id"],
	])("refuses %j", (options, option) => {
		expect(() => auditLogFilter(options)).toThrow(CliError);
		expect(() => auditLogFilter(options)).toThrow(option);
	});
});

describe("parseTime and formatTime", () => {
	it("reads a bare date as local midnight", () => {
		expect(parseTime("2026-11-16", "since")).toBe(
			new Date(2026, 10, 16).getTime(),
		);
	});

	it("prints the local time with its offset, which parses back", () => {
		const text = formatTime(T0 + 90 * 60_000);
		expect(text).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
		);
		expect(Date.parse(text)).toBe(T0 + 90 * 60_000);
	});
});

describe("readAuditLog", () => {
	it.each([
		{},
		{ fromAgentName: "grok" },
		{ toAgentName: "grok", categoryName: "予定" },
		{ outcome: "denied" as const },
		{ occurredFrom: T0 + HOUR_MS, occurredBefore: T0 + 2 * HOUR_MS },
		{ includeBody: true, limit: 1 },
		{ order: "desc" as const },
		{ order: "desc" as const, limit: 2 },
	])("returns what queryAuditLog returns for %j", async (filter) => {
		const entries = await readAuditLog(d1Client(db), filter);
		expect(entries).toEqual(await queryAuditLog(db, filter));
		expect(entries.length).toBeGreaterThan(0);
	});
});

describe("formatAuditLog", () => {
	it("prints names, and IDs only for what no longer exists", async () => {
		await db.prepare("DELETE FROM agents WHERE id = ?").bind(grok.id).run();
		const entries = await readAuditLog(d1Client(db), { includeBody: true });
		const [header, ...lines] = formatAuditLog(entries, true).split("\n");
		expect(header?.split("\t")).toEqual([
			"id",
			"occurred_at",
			"event_type",
			"from",
			"to",
			"category",
			"outcome",
			"reason_code",
			"message_id",
			"body",
		]);
		expect(lines.map((line) => line.split("\t")[0])).toEqual(
			entries.map((entry) => String(entry.id)),
		);
		expect(lines.map((line) => line.split("\t").slice(2))).toEqual([
			[
				"question_accepted",
				"muse",
				grok.id,
				"予定",
				"ok",
				"-",
				"q1",
				'"明日の\\t予定は？"',
			],
			[
				"question_blocked",
				grok.id,
				"muse",
				"予定",
				"denied",
				"no_allow_rule",
				"q2",
				"-",
			],
			["auth_failed", "-", "-", "-", "denied", "token_unknown", "-", "-"],
		]);
	});

	it("leaves the body column out unless asked", async () => {
		const entries = await readAuditLog(d1Client(db), {});
		expect(formatAuditLog(entries, false)).not.toContain("body");
	});
});

describe("wrangler output", () => {
	it("reads the rows of a successful --json --command", () => {
		const stdout = JSON.stringify([
			{ results: [{ n: 1 }], success: true, meta: { duration: 0 } },
		]);
		expect(parseWranglerRows(stdout)).toEqual([{ n: 1 }]);
	});

	it("reads the reason of a failure", () => {
		const stdout = JSON.stringify({
			error: { text: "no such table: agents: SQLITE_ERROR" },
		});
		expect(wranglerFailure(stdout, "")).toBe(
			"no such table: agents: SQLITE_ERROR",
		);
		expect(wranglerFailure("", "Not logged in.\n")).toBe("Not logged in.");
	});
});
