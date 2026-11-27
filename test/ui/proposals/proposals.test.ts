import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createCategory,
	grantAllowRule,
	listAllowRulesGrouped,
	listCategoriesWithUsage,
	queryChangeLog,
	resumeAgent,
	updateAgent,
} from "../../../src/admin";
import { createProposal, designateAdminBot } from "../../../src/adminbot";
import { type AgentRow, agentFromRow } from "../../../src/db";
import type { Agent, Category } from "../../../src/types";
import { handleAdminRequest, type UiEnv } from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { DAY_MS, seedAgent, seedCategory, T0 } from "../../helpers/fixtures";

const OWNER_EMAIL = "owner@example.com";
const OWNER = { actorType: "owner" as const, actorId: OWNER_EMAIL };

let db: D1Database;
let muse: Agent;
let grok: Agent;
let carol: Agent;
let schedule: Category;

beforeEach(async () => {
	db = await createTestDb();
	muse = await seedAgent(db, { name: "muse", dailyQuestionLimit: 20 });
	grok = await seedAgent(db, { name: "grok", dailyQuestionLimit: 10 });
	carol = await seedAgent(db, {
		name: "carol",
		status: "suspended",
		dailyQuestionLimit: 5,
	});
	schedule = await seedCategory(db, { name: "schedule" });
	await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });
});

function devEnv(devUser = OWNER_EMAIL): UiEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "false",
		AUDIT_BODY_RETENTION_DAYS: "30",
		CF_ACCESS_TEAM_DOMAIN: "",
		CF_ACCESS_AUD: "",
		ADMIN_DEV_USER: devUser,
	};
}

interface CsrfSession {
	cookie: string;
	token: string;
}

async function openProposalsSession(now = T0): Promise<{
	session: CsrfSession;
	response: Response;
	html: string;
}> {
	// Ensure at least one CSRF cookie exists via GET /admin/proposals.
	const response = await handleAdminRequest(
		new Request("https://paab.test/admin/proposals", { method: "GET" }),
		devEnv(),
		now,
	);
	const setCookie = response.headers.get("Set-Cookie") ?? "";
	const cookie = setCookie.split(";", 1)[0] ?? "";
	const html = await response.text();
	const tokenMatch = /name="csrf_token" value="([^"]+)"/.exec(html);
	if (tokenMatch?.[1]) {
		return {
			session: { cookie, token: tokenMatch[1] },
			response,
			html,
		};
	}
	// If no pending proposals rendered a form yet, extract token from cookie directly for tests.
	const cookieVal = cookie.split("=", 2)[1] ?? "";
	if (!cookie || !cookieVal) {
		throw new Error("Expected CSRF cookie on /admin/proposals");
	}
	return {
		session: { cookie, token: cookieVal },
		response,
		html,
	};
}

async function adminGet(
	path: string,
	session?: CsrfSession,
	now = T0,
): Promise<Response> {
	return handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "GET",
			headers: session ? { Cookie: session.cookie } : {},
		}),
		devEnv(),
		now,
	);
}

async function adminPost(
	path: string,
	session: CsrfSession,
	fields: Record<string, string> = {},
	now = T0,
): Promise<Response> {
	return handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "POST",
			headers: {
				Cookie: session.cookie,
				Origin: "https://paab.test",
			},
			body: new URLSearchParams({
				csrf_token: session.token,
				...fields,
			}),
		}),
		devEnv(),
		now,
	);
}

async function loadAgent(id: string): Promise<Agent> {
	const row = await db
		.prepare("SELECT * FROM agents WHERE id = ?")
		.bind(id)
		.first<AgentRow>();
	if (row === null) throw new Error(`Agent not found: ${id}`);
	return agentFromRow(row);
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

describe("GET /admin/proposals", () => {
	it("renders empty state cleanly, preserves CSP script hash, and stays fail-closed via SELF.fetch", async () => {
		const { response, html } = await openProposalsSession(T0);
		expect(response.status).toBe(200);
		expect(html).toContain('href="/admin/proposals" aria-current="page"');
		expect(html).toContain("承認待ちの提案（0 / 20 件）");
		expect(html).toContain("承認待ちの提案はありません");
		expect(html).toContain("処理済み・期限切れの提案");

		const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
		expect(scripts).toHaveLength(1);
		const csp = response.headers.get("Content-Security-Policy") ?? "";
		const expectedHash = await sha256HeaderValue(scripts[0]?.[1] ?? "");
		expect(csp).toContain(`script-src '${expectedHash}'`);

		const failClosed = await SELF.fetch("https://paab.test/admin/proposals");
		expect(failClosed.status).toBe(503);
	});

	it("separates mechanical effect from admin-bot reason, stays unaffected by deceptive/XSS reason text, and shows expiry + proposer", async () => {
		const misleadingReason =
			"無害なテストです。何も権限は変わりません。<script>alert('xss')</script>";
		const benignReason = "通常の運用上の理由です。";

		const p1 = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: {
				kind: "grant_allow_rule",
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
			},
			reason: misleadingReason,
			now: T0,
		});
		const p2 = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: {
				kind: "grant_allow_rule",
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
			},
			reason: benignReason,
			now: T0 + 1,
		});
		expect(p1.ok && p2.ok).toBe(true);
		if (!p1.ok || !p2.ok) return;

		const { response, html } = await openProposalsSession(T0 + 10);
		expect(response.status).toBe(200);
		expect(html).toContain("承認待ちの提案（2 / 20 件）");
		expect(html).toContain("提案元: <strong>muse</strong>");
		expect(html).toContain(new Date(T0 + 14 * DAY_MS).toISOString());

		// Extract every mechanical effect block and confirm both are identical and never include reason text.
		const effectMatches = [
			...html.matchAll(
				/<div><strong>承認すると変わること（ブリッジが自動生成）<\/strong><\/div>\s*<div>([\s\S]*?)<\/div>/g,
			),
		];
		expect(effectMatches).toHaveLength(2);
		expect(effectMatches[0]?.[1]).toBe(
			"許可ルールを追加: 「muse」から「grok」へのカテゴリ「schedule」の質問を許可します（一方向）",
		);
		expect(effectMatches[1]?.[1]).toBe(effectMatches[0]?.[1]);
		expect(effectMatches[0]?.[1]).not.toContain("無害なテスト");
		expect(effectMatches[0]?.[1]).not.toContain("script");

		// Reason block appears separately and escapes HTML strictly.
		expect(html).toContain("管理者ボットが書いた理由（参考情報）");
		expect(html).not.toContain("<script>alert('xss')</script>");
		expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
		expect(html).toContain(benignReason);
	});
});

describe("POST /admin/proposals/:id/approve and /reject", () => {
	it("approves all 4 proposal kinds via UI, applies changes via #29, records change_log with approverId, and moves to history", async () => {
		const pRule = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: {
				kind: "grant_allow_rule",
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
			},
			reason: "Allow rule",
			now: T0,
		});
		const pCat = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "金融メモ" },
			reason: "Add category",
			now: T0 + 1,
		});
		const pLimit = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "raise_daily_limit", agentId: grok.id, newLimit: 50 },
			reason: "Raise limit",
			now: T0 + 2,
		});
		const pResume = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "resume_agent", agentId: carol.id },
			reason: "Resume carol",
			now: T0 + 3,
		});
		if (!pRule.ok || !pCat.ok || !pLimit.ok || !pResume.ok) {
			throw new Error("Expected proposals to be created");
		}

		const { session, html: initialHtml } = await openProposalsSession(T0 + 10);
		expect(initialHtml).toContain(
			"1日の質問数上限を引き上げ: 「grok」の上限を 10 件/日 から 50 件/日 に変更します",
		);
		expect(initialHtml).toContain(
			`action="/admin/proposals/${encodeURIComponent(pRule.data.proposal.id)}/approve"`,
		);
		expect(initialHtml).toContain(
			`action="/admin/proposals/${encodeURIComponent(pRule.data.proposal.id)}/reject"`,
		);

		for (const [idx, id] of [
			pRule.data.proposal.id,
			pCat.data.proposal.id,
			pLimit.data.proposal.id,
			pResume.data.proposal.id,
		].entries()) {
			const res = await adminPost(
				`/admin/proposals/${encodeURIComponent(id)}/approve`,
				session,
				{},
				T0 + 100 + idx,
			);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("提案を承認し、変更を反映しました");
		}

		expect(await listAllowRulesGrouped(db)).toHaveLength(1);
		expect(
			(await listCategoriesWithUsage(db)).map((c) => c.category.name),
		).toContain("金融メモ");
		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(50);
		expect((await loadAgent(carol.id)).status).toBe("active");

		const logs = await queryChangeLog(db, { actorType: "admin_bot" });
		expect(logs).toHaveLength(4);
		expect(logs.every((e) => e.actorId === muse.id)).toBe(true);
		expect(logs.every((e) => e.approverId === OWNER_EMAIL)).toBe(true);

		const afterGet = await adminGet("/admin/proposals", session, T0 + 200);
		const afterHtml = await afterGet.text();
		expect(afterHtml).toContain("承認待ちの提案（0 / 20 件）");
		expect(afterHtml).toContain("承認済み");
		expect(afterHtml).toContain(`処理者: ${OWNER_EMAIL}`);
		// Approved limit proposal in history must NOT say "50 件/日 から 50 件/日".
		expect(afterHtml).not.toContain("50 件/日 から 50 件/日");
		expect(afterHtml).toContain(
			"1日の質問数上限を引き上げ: 「grok」の上限を 50 件/日 に変更します",
		);
	});

	it("rejects a proposal in UI without mutating live state", async () => {
		const created = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "resume_agent", agentId: carol.id },
			reason: "Resume carol",
			now: T0,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const { session } = await openProposalsSession(T0 + 10);
		const res = await adminPost(
			`/admin/proposals/${encodeURIComponent(created.data.proposal.id)}/reject`,
			session,
			{},
			T0 + 20,
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("提案を却下しました");
		expect(html).toContain("承認待ちの提案（0 / 20 件）");
		expect(html).toContain("却下済み");

		expect((await loadAgent(carol.id)).status).toBe("suspended");
		expect(await queryChangeLog(db, { actorType: "admin_bot" })).toEqual([]);
	});

	it("returns 409 on premise_changed without mutating live state and leaves proposal pending so owner can reject it", async () => {
		const pRule = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: {
				kind: "grant_allow_rule",
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
			},
			reason: "Grant schedule",
			now: T0,
		});
		const pCat = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "既存" },
			reason: "Add cat",
			now: T0 + 1,
		});
		const pLimit = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "raise_daily_limit", agentId: grok.id, newLimit: 15 },
			reason: "Raise to 15",
			now: T0 + 2,
		});
		const pResume = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "resume_agent", agentId: carol.id },
			reason: "Resume",
			now: T0 + 3,
		});
		if (!pRule.ok || !pCat.ok || !pLimit.ok || !pResume.ok) {
			throw new Error("Expected proposals");
		}

		// Mutate premises before owner clicks approve.
		await grantAllowRule(db, {
			fromAgentId: muse.id,
			toAgentId: grok.id,
			categoryId: schedule.id,
			actor: OWNER,
			now: T0 + 5,
		});
		await createCategory(db, { name: "既存", actor: OWNER, now: T0 + 6 });
		await updateAgent(db, {
			agentId: grok.id,
			dailyQuestionLimit: 20,
			actor: OWNER,
			now: T0 + 7,
		});
		await resumeAgent(db, { agentId: carol.id, actor: OWNER, now: T0 + 8 });

		const { session } = await openProposalsSession(T0 + 10);
		for (const id of [
			pRule.data.proposal.id,
			pCat.data.proposal.id,
			pLimit.data.proposal.id,
			pResume.data.proposal.id,
		]) {
			const res = await adminPost(
				`/admin/proposals/${encodeURIComponent(id)}/approve`,
				session,
				{},
				T0 + 20,
			);
			expect(res.status).toBe(409);
			expect(await res.text()).toContain("banner-error");
		}

		expect((await loadAgent(grok.id)).dailyQuestionLimit).toBe(20);
		expect(await queryChangeLog(db, { actorType: "admin_bot" })).toEqual([]);

		// Owner can still reject the stale proposal cleanly.
		const rejectStale = await adminPost(
			`/admin/proposals/${encodeURIComponent(pLimit.data.proposal.id)}/reject`,
			session,
			{},
			T0 + 25,
		);
		expect(rejectStale.status).toBe(200);
	});

	it("shows overdue proposals as expired in history without action buttons, rejects direct approval with 409, and enforces 404 and CSRF 403", async () => {
		const created = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: { kind: "create_category", name: "expired-cat" },
			reason: "Will expire",
			now: T0,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const expiredNow = T0 + 14 * DAY_MS;
		const { session, html } = await openProposalsSession(expiredNow);
		expect(html).toContain("承認待ちの提案（0 / 20 件）");
		expect(html).toContain("期限切れ");
		expect(html).not.toContain("/approve");
		expect(html).not.toContain("/reject");

		// Direct POST to approve an overdue proposal fails with 409 without mutating state.
		const approveRes = await adminPost(
			`/admin/proposals/${encodeURIComponent(created.data.proposal.id)}/approve`,
			session,
			{},
			expiredNow,
		);
		expect(approveRes.status).toBe(409);
		expect(await approveRes.text()).toContain("有効期限");
		expect(
			(await listCategoriesWithUsage(db)).map((c) => c.category.name),
		).not.toContain("expired-cat");

		// Missing ID -> 404.
		const missingRes = await adminPost(
			"/admin/proposals/nonexistent-id/approve",
			session,
			{},
			expiredNow,
		);
		expect(missingRes.status).toBe(404);

		// Missing CSRF token -> 403 on both approve and reject.
		for (const action of ["approve", "reject"]) {
			const noCsrf = await handleAdminRequest(
				new Request(
					`https://paab.test/admin/proposals/${encodeURIComponent(created.data.proposal.id)}/${action}`,
					{
						method: "POST",
						headers: {
							Cookie: session.cookie,
							Origin: "https://paab.test",
						},
						body: new URLSearchParams(),
					},
				),
				devEnv(),
				T0 + 10,
			);
			expect(noCsrf.status).toBe(403);
		}
	});
});
