import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogFilter, readAuditLog } from "../../../scripts/lib/audit";
import type { D1Client, Row } from "../../../scripts/lib/sql";
import {
	type AuditBodyConfig,
	type AuditEvent,
	type AuditLogFilter,
	recordAuditEvent,
	recordAuditEvents,
} from "../../../src/audit";
import type { Agent, Category } from "../../../src/types";
import { handleAdminRequest, type UiEnv } from "../../../src/ui";
import { parseAuditTime } from "../../../src/ui/audit";
import { createTestDb } from "../../helpers/db";
import {
	DAY_MS,
	HOUR_MS,
	seedAgent,
	seedCategory,
	T0,
} from "../../helpers/fixtures";

const RECORDING_ON: AuditBodyConfig = {
	recordBodies: true,
	bodyRetentionDays: 30,
};

function uiEnv(overrides: Partial<UiEnv> = {}): UiEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "false",
		AUDIT_BODY_RETENTION_DAYS: "30",
		CF_ACCESS_TEAM_DOMAIN: "",
		CF_ACCESS_AUD: "",
		ADMIN_DEV_USER: "owner@example.com",
		...overrides,
	};
}

function localD1Client(db: D1Database): D1Client {
	return {
		async query(statement) {
			return (await db.prepare(statement).all<Row>()).results;
		},
		async execute(statements) {
			await db.batch(statements.map((statement) => db.prepare(statement)));
		},
	};
}

function decodeHtml(text: string): string {
	return text
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'");
}

function stripTags(htmlText: string): string {
	return decodeHtml(htmlText.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

interface ParsedRow {
	id: number;
	occurredAtDatetime: string;
	eventType: string;
	from: string;
	to: string;
	category: string;
	outcome: string;
	reasonCode: string;
	messageId: string;
	messageIdHref: string | null;
	body?: string;
}

function parseTableRows(htmlText: string): ParsedRow[] {
	const tbodyMatch = /<tbody>([\s\S]*?)<\/tbody>/.exec(htmlText);
	if (tbodyMatch === null) {
		return [];
	}
	const rows: ParsedRow[] = [];
	for (const trMatch of tbodyMatch[1]?.matchAll(/<tr>([\s\S]*?)<\/tr>/g) ??
		[]) {
		const cells = [
			...(trMatch[1]?.matchAll(/<td>([\s\S]*?)<\/td>/g) ?? []),
		].map((m) => m[1] ?? "");
		if (cells.length < 9) {
			continue;
		}
		const timeMatch = /datetime="([^"]+)"/.exec(cells[1] ?? "");
		const msgHrefMatch = /href="([^"]+)"/.exec(cells[8] ?? "");
		rows.push({
			id: Number(stripTags(cells[0] ?? "")),
			occurredAtDatetime: decodeHtml(timeMatch?.[1] ?? ""),
			eventType: stripTags(cells[2] ?? ""),
			from: stripTags(cells[3] ?? ""),
			to: stripTags(cells[4] ?? ""),
			category: stripTags(cells[5] ?? ""),
			outcome: stripTags(cells[6] ?? ""),
			reasonCode: stripTags(cells[7] ?? ""),
			messageId: stripTags(cells[8] ?? ""),
			messageIdHref: msgHrefMatch?.[1] ? decodeHtml(msgHrefMatch[1]) : null,
			...(cells.length >= 10 ? { body: decodeHtml(cells[9] ?? "") } : {}),
		});
	}
	return rows;
}

function extractRelHref(htmlText: string, rel: "next" | "prev"): string | null {
	const pattern = new RegExp(`rel="${rel}" href="([^"]+)"`);
	const match = pattern.exec(htmlText);
	return match?.[1] ? decodeHtml(match[1]) : null;
}

async function sha256HeaderValue(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	let binary = "";
	for (const byte of new Uint8Array(digest)) {
		binary += String.fromCharCode(byte);
	}
	return `sha256-${btoa(binary)}`;
}

async function fetchAuditHtml(
	pathAndQuery: string,
	envOverrides: Partial<UiEnv> = {},
): Promise<{ status: number; headers: Headers; text: string }> {
	const response = await handleAdminRequest(
		new Request(`https://paab.test${pathAndQuery}`, { method: "GET" }),
		uiEnv(envOverrides),
		T0,
	);
	return {
		status: response.status,
		headers: response.headers,
		text: await response.text(),
	};
}

let db: D1Database;
let muse: Agent;
let grok: Agent;
let carol: Agent;
let schedule: Category;
let health: Category;

async function seedStandardFixture(): Promise<void> {
	const events: AuditEvent[] = [
		{
			occurredAt: T0,
			eventType: "question_accepted",
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			messageId: "msg-q1",
			body: "明日の予定は？",
		},
		{
			occurredAt: T0 + 10 * 60_000,
			eventType: "question_delivered",
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			messageId: "msg-q1",
		},
		{
			occurredAt: T0 + 20 * 60_000,
			eventType: "question_answered",
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			messageId: "msg-q1",
			body: "10時から会議です。",
		},
		{
			occurredAt: T0 + HOUR_MS,
			eventType: "question_blocked",
			reasonCode: "no_allow_rule",
			fromAgentId: grok.id,
			toAgentId: muse.id,
			categoryId: health.id,
			messageId: "msg-q2",
			body: "秘密の質問 <script>alert(1)</script>",
		},
		{
			occurredAt: T0 + 2 * HOUR_MS,
			eventType: "question_expired",
			fromAgentId: muse.id,
			toAgentId: carol.id,
			categoryId: health.id,
			messageId: "msg-q3",
		},
		{
			occurredAt: T0 + DAY_MS,
			eventType: "auth_failed",
			reasonCode: "token_unknown",
			messageId: "msg-auth",
		},
	];
	for (const event of events) {
		expect(await recordAuditEvent(db, RECORDING_ON, event)).toBe(true);
	}
}

beforeEach(async () => {
	db = await createTestDb();
	muse = await seedAgent(db, { name: "muse" });
	grok = await seedAgent(db, { name: "grok" });
	carol = await seedAgent(db, { name: "carol's bot" });
	schedule = await seedCategory(db, { name: "予定" });
	health = await seedCategory(db, { name: "health" });
});

describe("Admin Audit Log UI (/admin/audit)", () => {
	it("respects Access protection, strict CSP script hash, and <time> formatting", async () => {
		await seedStandardFixture();

		const unconfigured = await handleAdminRequest(
			new Request("https://paab.test/admin/audit", { method: "GET" }),
			{
				DB: db,
				CF_ACCESS_TEAM_DOMAIN: "",
				CF_ACCESS_AUD: "",
			},
			T0,
		);
		expect(unconfigured.status).toBe(503);

		const res = await fetchAuditHtml("/admin/audit");
		expect(res.status).toBe(200);
		expect(res.text).toContain('href="/admin/audit" aria-current="page"');

		const csp = res.headers.get("Content-Security-Policy") ?? "";
		const scriptMatches = [
			...res.text.matchAll(/<script>([\s\S]*?)<\/script>/g),
		];
		expect(scriptMatches).toHaveLength(1);
		const expectedHash = await sha256HeaderValue(scriptMatches[0]?.[1] ?? "");
		expect(csp).toContain(`script-src '${expectedHash}'`);

		const rows = parseTableRows(res.text);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]?.occurredAtDatetime).toBe(
			new Date(T0 + 2 * HOUR_MS).toISOString(),
		);
	});

	it("hides auth_failed by default and includes it when show_auth_failed=1", async () => {
		await seedStandardFixture();

		const defaultRes = await fetchAuditHtml("/admin/audit");
		expect(defaultRes.status).toBe(200);
		const defaultRows = parseTableRows(defaultRes.text);
		expect(defaultRows.some((r) => r.eventType === "auth_failed")).toBe(false);
		expect(defaultRows.map((r) => r.eventType)).toEqual([
			"question_expired",
			"question_blocked",
			"question_answered",
			"question_delivered",
			"question_accepted",
		]);

		const withAuthRes = await fetchAuditHtml("/admin/audit?show_auth_failed=1");
		expect(withAuthRes.status).toBe(200);
		const withAuthRows = parseTableRows(withAuthRes.text);
		expect(withAuthRows[0]?.eventType).toBe("auth_failed");
		expect(withAuthRows[0]?.reasonCode).toBe("token_unknown");
		expect(withAuthRows).toHaveLength(6);
	});

	it("shows reply_delivered, answer_failed, and agent_suspended_rejected by default", async () => {
		const events: AuditEvent[] = [
			{
				occurredAt: T0,
				eventType: "reply_delivered",
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
				messageId: "msg-reply",
			},
			{
				occurredAt: T0 + 1000,
				eventType: "answer_failed",
				fromAgentId: carol.id,
				reasonCode: "not_recipient",
				messageId: "msg-reply",
			},
			{
				occurredAt: T0 + 2000,
				eventType: "agent_suspended_rejected",
				fromAgentId: grok.id,
				reasonCode: "sender_suspended",
			},
			{
				occurredAt: T0 + 3000,
				eventType: "auth_failed",
				reasonCode: "token_unknown",
			},
		];
		expect(await recordAuditEvents(db, RECORDING_ON, events)).toBe(true);

		const defaultRes = await fetchAuditHtml("/admin/audit");
		expect(defaultRes.status).toBe(200);
		const rows = parseTableRows(defaultRes.text);
		expect(rows.map((r) => [r.eventType, r.outcome, r.reasonCode])).toEqual([
			["agent_suspended_rejected", "denied", "sender_suspended"],
			["answer_failed", "denied", "not_recipient"],
			["reply_delivered", "ok", "-"],
		]);
	});

	it("hides bodies by default even when AUDIT_RECORD_BODIES=true, and shows them only when show_body=1 and recording is enabled", async () => {
		await seedStandardFixture();

		const hiddenByDefault = await fetchAuditHtml("/admin/audit", {
			AUDIT_RECORD_BODIES: "true",
			AUDIT_BODY_RETENTION_DAYS: "30",
		});
		expect(hiddenByDefault.status).toBe(200);
		expect(hiddenByDefault.text).not.toContain("明日の予定は？");
		expect(hiddenByDefault.text).not.toContain("10時から会議です。");
		expect(hiddenByDefault.text).not.toContain("<th>本文</th>");

		const shownWhenEnabled = await fetchAuditHtml("/admin/audit?show_body=1", {
			AUDIT_RECORD_BODIES: "true",
			AUDIT_BODY_RETENTION_DAYS: "30",
		});
		expect(shownWhenEnabled.status).toBe(200);
		expect(shownWhenEnabled.text).toContain("<th>本文</th>");
		expect(shownWhenEnabled.text).toContain("明日の予定は？");
		expect(shownWhenEnabled.text).toContain("10時から会議です。");
		expect(shownWhenEnabled.text).toContain(
			"秘密の質問 &lt;script&gt;alert(1)&lt;/script&gt;",
		);
		expect(shownWhenEnabled.text).not.toContain("<script>alert(1)</script>");

		const disabledFlag = await fetchAuditHtml("/admin/audit?show_body=1", {
			AUDIT_RECORD_BODIES: "false",
			AUDIT_BODY_RETENTION_DAYS: "30",
		});
		expect(disabledFlag.status).toBe(200);
		expect(disabledFlag.text).not.toContain("<th>本文</th>");
		expect(disabledFlag.text).not.toContain("明日の予定は？");
		expect(disabledFlag.text).toContain("本文記録は無効");

		const zeroRetention = await fetchAuditHtml("/admin/audit?show_body=1", {
			AUDIT_RECORD_BODIES: "true",
			AUDIT_BODY_RETENTION_DAYS: "0",
		});
		expect(zeroRetention.status).toBe(200);
		expect(zeroRetention.text).not.toContain("<th>本文</th>");
		expect(zeroRetention.text).not.toContain("明日の予定は？");
		expect(zeroRetention.text).toContain("本文記録は無効");
	});

	it("matches CLI readAuditLog across period, from, to, category, outcome, and body filters", async () => {
		await seedStandardFixture();
		const client = localD1Client(db);

		const cases: Array<{
			name: string;
			query: string;
			cliOptions: Parameters<typeof auditLogFilter>[0];
			extraFilter?: Partial<AuditLogFilter>;
		}> = [
			{
				name: "default excluding auth_failed",
				query: "",
				cliOptions: {},
				extraFilter: { excludeEventTypes: ["auth_failed"] },
			},
			{
				name: "period with ISO offset",
				query:
					"?since=2026-11-16T09:10%2B09:00&before=2026-11-16T11:30%2B09:00",
				cliOptions: {
					since: "2026-11-16T09:10+09:00",
					before: "2026-11-16T11:30+09:00",
				},
				extraFilter: { excludeEventTypes: ["auth_failed"] },
			},
			{
				name: "period with YYYY-MM-DD and show_auth_failed=1",
				query: "?since=2026-11-16&before=2026-11-17&show_auth_failed=1",
				cliOptions: {
					since: "2026-11-16",
					before: "2026-11-17",
				},
			},
			{
				name: "from and category",
				query: `?from=muse&category=${encodeURIComponent("予定")}`,
				cliOptions: { from: "muse", category: "予定" },
				extraFilter: { excludeEventTypes: ["auth_failed"] },
			},
			{
				name: "to with apostrophe",
				query: `?to=${encodeURIComponent("carol's bot")}`,
				cliOptions: { to: "carol's bot" },
				extraFilter: { excludeEventTypes: ["auth_failed"] },
			},
			{
				name: "outcome denied with auth_failed included",
				query: "?outcome=denied&show_auth_failed=1",
				cliOptions: { outcome: "denied" },
			},
			{
				name: "outcome expired",
				query: "?outcome=expired",
				cliOptions: { outcome: "expired" },
				extraFilter: { excludeEventTypes: ["auth_failed"] },
			},
			{
				name: "outcome ok with body enabled",
				query: "?outcome=ok&show_body=1",
				cliOptions: { outcome: "ok", body: true },
				extraFilter: { excludeEventTypes: ["auth_failed"] },
			},
		];

		for (const testCase of cases) {
			const cliFilter: AuditLogFilter = {
				...auditLogFilter(testCase.cliOptions),
				...testCase.extraFilter,
			};
			const cliEntries = await readAuditLog(client, cliFilter);
			const res = await fetchAuditHtml(`/admin/audit${testCase.query}`, {
				AUDIT_RECORD_BODIES: "true",
				AUDIT_BODY_RETENTION_DAYS: "30",
			});
			expect(res.status, testCase.name).toBe(200);
			const rows = parseTableRows(res.text);
			expect(
				rows.map((r) => r.id),
				testCase.name,
			).toEqual(cliEntries.map((e) => e.id));
			if (testCase.cliOptions.body) {
				expect(
					rows.map((r) => r.body),
					testCase.name,
				).toEqual(cliEntries.map((e) => e.body ?? "-"));
			}
		}

		// Also verify HTML datetime-local input format (without offset) works in UI.
		const dtLocalRes = await fetchAuditHtml(
			"/admin/audit?since=2026-11-16T01:00&before=2026-11-16T02:00",
		);
		expect(dtLocalRes.status).toBe(200);
		expect(parseTableRows(dtLocalRes.text).map((r) => r.messageId)).toEqual([
			"msg-q2",
		]);
		expect(parseAuditTime("2026-11-16T01:00")).toBe(T0 + HOUR_MS);
	});

	it("traces a question lifecycle via clickable message_id links preserving view flags", async () => {
		await seedStandardFixture();

		const listRes = await fetchAuditHtml(
			"/admin/audit?show_auth_failed=1&show_body=1",
			{
				AUDIT_RECORD_BODIES: "true",
				AUDIT_BODY_RETENTION_DAYS: "30",
			},
		);
		const rows = parseTableRows(listRes.text);
		const q1Row = rows.find((r) => r.messageId === "msg-q1");
		expect(q1Row?.messageIdHref).toBeTruthy();

		const traceUrl = new URL(`https://paab.test${q1Row?.messageIdHref ?? ""}`);
		expect(traceUrl.pathname).toBe("/admin/audit");
		expect(traceUrl.searchParams.get("message_id")).toBe("msg-q1");
		expect(traceUrl.searchParams.get("show_auth_failed")).toBe("1");
		expect(traceUrl.searchParams.get("show_body")).toBe("1");

		const traceRes = await fetchAuditHtml(
			`${traceUrl.pathname}${traceUrl.search}`,
			{
				AUDIT_RECORD_BODIES: "true",
				AUDIT_BODY_RETENTION_DAYS: "30",
			},
		);
		expect(traceRes.status).toBe(200);
		const traceRows = parseTableRows(traceRes.text);
		expect(traceRows.map((r) => r.eventType)).toEqual([
			"question_answered",
			"question_delivered",
			"question_accepted",
		]);
		expect(traceRows[0]?.body).toBe("10時から会議です。");
	});

	it("renders stored IDs when referenced agents or categories have been deleted", async () => {
		await seedStandardFixture();
		await db.prepare("DELETE FROM agents WHERE id = ?").bind(carol.id).run();
		await db
			.prepare("DELETE FROM categories WHERE id = ?")
			.bind(health.id)
			.run();

		const res = await fetchAuditHtml("/admin/audit");
		expect(res.status).toBe(200);
		const rows = parseTableRows(res.text);
		const q3Row = rows.find((r) => r.messageId === "msg-q3");
		expect(q3Row).toBeDefined();
		expect(q3Row?.from).toBe("muse");
		expect(q3Row?.to).toContain(carol.id);
		expect(q3Row?.to).toContain("削除済み");
		expect(q3Row?.category).toContain(health.id);
		expect(q3Row?.category).toContain("削除済み");
	});

	it("paginates forward and backward across >1,000 entries without skipping or looping", async () => {
		const total = 1050;
		const bulkEvents: AuditEvent[] = [];
		for (let i = 1; i <= total; i += 1) {
			bulkEvents.push({
				occurredAt: T0 + i * 1000,
				eventType: "question_accepted",
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
				messageId: `bulk-${String(i).padStart(4, "0")}`,
			});
		}
		expect(await recordAuditEvents(db, RECORDING_ON, bulkEvents)).toBe(true);

		const forwardPages: ParsedRow[][] = [];
		let currentHref: string | null = "/admin/audit?limit=100";
		const visitedHrefs = new Set<string>();

		while (currentHref !== null) {
			expect(visitedHrefs.has(currentHref)).toBe(false);
			visitedHrefs.add(currentHref);

			const res = await fetchAuditHtml(currentHref);
			expect(res.status).toBe(200);
			const rows = parseTableRows(res.text);
			forwardPages.push(rows);
			if (forwardPages.length === 1) {
				expect(extractRelHref(res.text, "prev")).toBeNull();
			} else {
				expect(extractRelHref(res.text, "prev")).not.toBeNull();
			}
			currentHref = extractRelHref(res.text, "next");
			expect(forwardPages.length).toBeLessThanOrEqual(12);
		}

		expect(forwardPages).toHaveLength(11);
		expect(forwardPages.slice(0, 10).every((p) => p.length === 100)).toBe(true);
		expect(forwardPages[10]).toHaveLength(50);

		const allForwardIds = forwardPages.flat().map((r) => r.messageId);
		const expectedIds = Array.from(
			{ length: total },
			(_, idx) => `bulk-${String(total - idx).padStart(4, "0")}`,
		);
		expect(allForwardIds).toEqual(expectedIds);

		// Walk backward from the oldest page back to the newest page using rel="prev".
		const lastPageHref = `/admin/audit?limit=100&before_id=${forwardPages[9]?.[99]?.id ?? 0}`;
		const lastRes = await fetchAuditHtml(lastPageHref);
		let prevHref = extractRelHref(lastRes.text, "prev");
		const backwardPages: ParsedRow[][] = [parseTableRows(lastRes.text)];
		const visitedBack = new Set<string>([lastPageHref]);

		while (prevHref !== null) {
			expect(visitedBack.has(prevHref)).toBe(false);
			visitedBack.add(prevHref);

			const res = await fetchAuditHtml(prevHref);
			expect(res.status).toBe(200);
			backwardPages.push(parseTableRows(res.text));
			prevHref = extractRelHref(res.text, "prev");
			expect(backwardPages.length).toBeLessThanOrEqual(12);
		}

		expect(backwardPages).toHaveLength(11);
		expect(
			backwardPages.reverse().map((p) => p.map((r) => r.messageId)),
		).toEqual(forwardPages.map((p) => p.map((r) => r.messageId)));

		// Also verify boundary with limit=999 (capped from 2000) across 1,050 entries.
		const bigPage1 = await fetchAuditHtml("/admin/audit?limit=2000");
		expect(bigPage1.status).toBe(200);
		expect(parseTableRows(bigPage1.text)).toHaveLength(999);
		const bigNext = extractRelHref(bigPage1.text, "next");
		expect(bigNext).toBeTruthy();

		const bigPage2 = await fetchAuditHtml(bigNext ?? "");
		expect(bigPage2.status).toBe(200);
		expect(parseTableRows(bigPage2.text)).toHaveLength(51);
		expect(extractRelHref(bigPage2.text, "next")).toBeNull();
	});

	it.each([
		["non-date since", "/admin/audit?since=not-a-date"],
		["impossible calendar date", "/admin/audit?since=2026-02-30"],
		["non-leap-year Feb 29", "/admin/audit?before=2026-02-29"],
		["out-of-range hour", "/admin/audit?since=2026-11-16T25:00"],
		["space separator instead of T", "/admin/audit?before=2026-11-16%2009:00"],
		["unknown outcome", "/admin/audit?outcome=maybe"],
		["zero limit", "/admin/audit?limit=0"],
		["negative limit", "/admin/audit?limit=-5"],
		["non-numeric limit", "/admin/audit?limit=abc"],
		["negative before_id", "/admin/audit?before_id=-1"],
		["non-numeric after_id", "/admin/audit?after_id=abc"],
		["both before_id and after_id", "/admin/audit?before_id=10&after_id=5"],
		[
			"XSS payload in since",
			"/admin/audit?since=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
		],
	])("returns clean escaped 400 UI on %s", async (_label, path) => {
		const res = await fetchAuditHtml(path);
		expect(res.status).toBe(400);
		expect(res.text).toContain('class="banner banner-error"');
		expect(res.text).not.toContain("<script>alert(1)</script>");
		if (path.includes("alert(1)")) {
			expect(res.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		}
	});
});
