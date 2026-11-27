import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, queryChangeLog } from "../../../src/admin";
import {
	approvePendingDescription,
	clearAdminBot,
	designateAdminBot,
	submitPendingDescription,
} from "../../../src/adminbot";
import { issueToken } from "../../../src/auth";
import {
	type AgentRow,
	agentFromRow,
	insertAllowRule,
	type PendingDescriptionRow,
} from "../../../src/db";
import type { Agent, Category } from "../../../src/types";
import { handleAdminRequest, type UiEnv } from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { seedAgent, seedCategory, T0 } from "../../helpers/fixtures";
import { call, connect } from "../../mcp/support";

const OWNER_EMAIL = "owner@example.com";
const OWNER = { actorType: "owner" as const, actorId: OWNER_EMAIL };

let db: D1Database;
let muse: Agent;
let grok: Agent;
let carol: Agent;
let schedule: Category;

beforeEach(async () => {
	db = await createTestDb();
	muse = await seedAgent(db, {
		name: "muse",
		description: "Published muse description",
	});
	grok = await seedAgent(db, {
		name: "grok",
		description: "Published grok description",
	});
	carol = await seedAgent(db, {
		name: "carol",
		description: "",
		status: "suspended",
	});
	schedule = await seedCategory(db, { name: "schedule" });
	await insertAllowRule(db, {
		fromAgentId: muse.id,
		toAgentId: grok.id,
		categoryId: schedule.id,
		createdAt: T0,
	}).run();
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

async function openDescriptionsSession(now = T0): Promise<{
	session: CsrfSession;
	response: Response;
	html: string;
}> {
	const response = await handleAdminRequest(
		new Request("https://paab.test/admin/descriptions", { method: "GET" }),
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
	const cookieVal = cookie.split("=", 2)[1] ?? "";
	if (!cookie || !cookieVal) {
		throw new Error("Expected CSRF cookie on /admin/descriptions");
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
): Promise<{ response: Response; html: string }> {
	const response = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "GET",
			headers: session ? { Cookie: session.cookie } : {},
		}),
		devEnv(),
		now,
	);
	return { response, html: await response.text() };
}

async function adminPost(
	path: string,
	session: CsrfSession,
	fields: Record<string, string> = {},
	now = T0,
): Promise<{ response: Response; html: string }> {
	const response = await handleAdminRequest(
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
	return { response, html: await response.text() };
}

async function loadAgent(id: string): Promise<Agent> {
	const row = await db
		.prepare("SELECT * FROM agents WHERE id = ?")
		.bind(id)
		.first<AgentRow>();
	if (row === null) throw new Error(`Agent not found: ${id}`);
	return agentFromRow(row);
}

async function loadPendingRow(
	agentId: string,
): Promise<PendingDescriptionRow | null> {
	return db
		.prepare("SELECT * FROM pending_descriptions WHERE agent_id = ?")
		.bind(agentId)
		.first<PendingDescriptionRow>();
}

function extractFormSubmissionId(
	html: string,
	agentId: string,
	action: "approve" | "reject",
): string {
	const escapedAction =
		`/admin/descriptions/${encodeURIComponent(agentId)}/${action}`.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);
	const match = new RegExp(
		`action="${escapedAction}"[\\s\\S]*?<input type="hidden" name="submission_id" value="([^"]+)"`,
	).exec(html);
	if (!match?.[1]) {
		throw new Error(
			`Expected hidden submission_id input for ${action} of ${agentId}`,
		);
	}
	return match[1];
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

describe("GET /admin/descriptions", () => {
	it("renders empty state with no-admin-bot notice, preserves CSP hash, and stays fail-closed via SELF.fetch", async () => {
		const { response, html } = await openDescriptionsSession(T0);
		expect(response.status).toBe(200);
		expect(html).toContain('href="/admin/descriptions" aria-current="page"');
		expect(html).toContain(
			"現在管理者ボットは未指名のため、すべての説明文をこの画面で承認・却下します",
		);
		expect(html).toContain("承認待ちの説明文（0 件）");
		expect(html).toContain("承認待ちの説明文はありません");

		const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
		expect(scripts).toHaveLength(1);
		const csp = response.headers.get("Content-Security-Policy") ?? "";
		const expectedHash = await sha256HeaderValue(scripts[0]?.[1] ?? "");
		expect(csp).toContain(`script-src '${expectedHash}'`);

		const failClosed = await SELF.fetch("https://paab.test/admin/descriptions");
		expect(failClosed.status).toBe(503);
	});

	it("renders admin bot badge, suspended status badge, side-by-side comparison, and escapes XSS", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });

		const xssPending =
			'<script>alert("xss")</script> & <img src=x onerror=alert(1)>';
		const museSub = await submitPendingDescription(db, {
			agentId: muse.id,
			description: "Muse updated bio",
			now: T0 + 10,
		});
		const carolSub = await submitPendingDescription(db, {
			agentId: carol.id,
			description: xssPending,
			now: T0 + 20,
		});
		if (!museSub.ok || !carolSub.ok) throw new Error("Expected submits");

		const { response, html } = await openDescriptionsSession(T0 + 30);
		expect(response.status).toBe(200);
		expect(html).not.toContain("現在管理者ボットは未指名のため");
		expect(html).toContain("承認待ちの説明文（2 件）");
		expect(html).toContain("管理者ボット自身・画面承認のみ");
		expect(html).toContain("停止中");
		expect(html).toContain("現在公開中の説明文");
		expect(html).toContain(
			"提出された説明文（エージェントが書いた外部データ）",
		);
		expect(html).toContain("Published muse description");
		expect(html).toContain("Muse updated bio");
		expect(html).toContain("（未設定）");
		expect(html).not.toContain('<script>alert("xss")</script>');
		expect(html).toContain(
			"&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
		);
		expect(html).toContain("承認して公開する");
		expect(html).toContain("却下する");
		expect(extractFormSubmissionId(html, muse.id, "approve")).toBe(
			museSub.data.pending.submissionId,
		);
		expect(extractFormSubmissionId(html, muse.id, "reject")).toBe(
			museSub.data.pending.submissionId,
		);
		expect(extractFormSubmissionId(html, carol.id, "approve")).toBe(
			carolSub.data.pending.submissionId,
		);
		expect(extractFormSubmissionId(html, carol.id, "reject")).toBe(
			carolSub.data.pending.submissionId,
		);
	});
});

describe("POST /admin/descriptions/:agentId/approve and /reject", () => {
	it("lets owner approve admin bot's own description and any agent when no admin bot is designated", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });
		await submitPendingDescription(db, {
			agentId: muse.id,
			description: "Owner-approved muse bio",
			now: T0 + 5,
		});

		const { session, html: initialHtml } = await openDescriptionsSession(
			T0 + 10,
		);
		const museSubmissionId = extractFormSubmissionId(
			initialHtml,
			muse.id,
			"approve",
		);

		// Missing submission_id returns 400 and leaves pending row untouched.
		const missingSubmissionApprove = await adminPost(
			`/admin/descriptions/${encodeURIComponent(muse.id)}/approve`,
			session,
			{},
			T0 + 14,
		);
		expect(missingSubmissionApprove.response.status).toBe(400);
		expect(missingSubmissionApprove.html).toContain("提出IDを指定してください");
		expect(await loadPendingRow(muse.id)).not.toBeNull();

		const missingSubmissionReject = await adminPost(
			`/admin/descriptions/${encodeURIComponent(muse.id)}/reject`,
			session,
			{ submission_id: "   " },
			T0 + 14,
		);
		expect(missingSubmissionReject.response.status).toBe(400);
		expect(missingSubmissionReject.html).toContain("提出IDを指定してください");

		const approveBot = await adminPost(
			`/admin/descriptions/${encodeURIComponent(muse.id)}/approve`,
			session,
			{ submission_id: museSubmissionId },
			T0 + 15,
		);
		expect(approveBot.response.status).toBe(200);
		expect(approveBot.html).toContain("説明文を承認して公開しました");
		expect((await loadAgent(muse.id)).description).toBe(
			"Owner-approved muse bio",
		);
		expect(await loadPendingRow(muse.id)).toBeNull();

		// Clear admin bot designation: owner handles all agents on /admin/descriptions.
		await clearAdminBot(db, { actor: OWNER, now: T0 + 20 });
		const grokSub = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "Approved while no admin bot",
			now: T0 + 25,
		});
		const carolSub = await submitPendingDescription(db, {
			agentId: carol.id,
			description: "Rejected while no admin bot",
			now: T0 + 26,
		});
		if (!grokSub.ok || !carolSub.ok) throw new Error("Expected submits");

		const approveGrok = await adminPost(
			`/admin/descriptions/${encodeURIComponent(grok.id)}/approve`,
			session,
			{ submission_id: grokSub.data.pending.submissionId },
			T0 + 30,
		);
		expect(approveGrok.response.status).toBe(200);
		expect(approveGrok.html).toContain(
			"現在管理者ボットは未指名のため、すべての説明文をこの画面で承認・却下します",
		);
		expect((await loadAgent(grok.id)).description).toBe(
			"Approved while no admin bot",
		);

		// Verify list_agents sees grok's newly approved description.
		const museToken = (
			await issueToken(db, {
				agentId: muse.id,
				purpose: "participant",
				now: T0 + 31,
			})
		).token;
		const museMcp = await connect(museToken, { now: T0 + 32 });
		const listed = await call(museMcp, "list_agents");
		expect(listed.text).toContain("Approved while no admin bot");

		const rejectCarol = await adminPost(
			`/admin/descriptions/${encodeURIComponent(carol.id)}/reject`,
			session,
			{ submission_id: carolSub.data.pending.submissionId },
			T0 + 35,
		);
		expect(rejectCarol.response.status).toBe(200);
		expect(rejectCarol.html).toContain("説明文を却下しました");
		expect((await loadAgent(carol.id)).description).toBe("");
		expect(await loadPendingRow(carol.id)).toBeNull();

		// Double-approve returns 404.
		const doubleApprove = await adminPost(
			`/admin/descriptions/${encodeURIComponent(grok.id)}/approve`,
			session,
			{ submission_id: grokSub.data.pending.submissionId },
			T0 + 40,
		);
		expect(doubleApprove.response.status).toBe(404);
		expect(doubleApprove.html).toContain("承認待ちの説明文が見つかりません");

		// Missing CSRF returns 403.
		const noCsrf = await handleAdminRequest(
			new Request(
				`https://paab.test/admin/descriptions/${encodeURIComponent(grok.id)}/reject`,
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
			T0 + 45,
		);
		expect(noCsrf.status).toBe(403);
	});

	it("returns 409 Conflict on TOCTOU overwrite between GET /admin/descriptions and POST approve/reject, then succeeds with fresh submission_id", async () => {
		const grokToken = (
			await issueToken(db, {
				agentId: grok.id,
				purpose: "participant",
				now: T0,
			})
		).token;

		const grokMcp1 = await connect(grokToken, { now: T0 + 5 });
		const submitD1 = await call(grokMcp1, "submit_description", {
			description: "Benign D1 bio for UI review",
		});
		expect(submitD1.isError).toBe(false);

		// Owner opens /admin/descriptions and sees benign D1 with hidden submission_id S1.
		const { session, html: pageD1 } = await openDescriptionsSession(T0 + 10);
		expect(pageD1).toContain("Benign D1 bio for UI review");
		const s1Approve = extractFormSubmissionId(pageD1, grok.id, "approve");
		const s1Reject = extractFormSubmissionId(pageD1, grok.id, "reject");
		expect(s1Approve).toBe(s1Reject);

		// Agent overwrites pending description with malicious D2 before owner submits form.
		const grokMcp2 = await connect(grokToken, { now: T0 + 15 });
		const submitD2 = await call(grokMcp2, "submit_description", {
			description: "Malicious D2 bio swapped before click",
		});
		expect(submitD2.isError).toBe(false);

		// Approving with stale S1 fails with HTTP 409, leaving agents.description and change_log untouched.
		const staleApprove = await adminPost(
			`/admin/descriptions/${encodeURIComponent(grok.id)}/approve`,
			session,
			{ submission_id: s1Approve },
			T0 + 20,
		);
		expect(staleApprove.response.status).toBe(409);
		expect(staleApprove.html).toContain(
			"承認待ちの説明文が新しい内容へ更新されたため処理できませんでした",
		);
		expect(staleApprove.html).toContain(
			"Malicious D2 bio swapped before click",
		);
		expect((await loadAgent(grok.id)).description).toBe(
			"Published grok description",
		);
		expect(
			await queryChangeLog(db, { targetType: "description" }),
		).toHaveLength(0);
		expect((await loadPendingRow(grok.id))?.description).toBe(
			"Malicious D2 bio swapped before click",
		);

		// Rejecting with stale S1 also fails with HTTP 409 and keeps D2 pending.
		const staleReject = await adminPost(
			`/admin/descriptions/${encodeURIComponent(grok.id)}/reject`,
			session,
			{ submission_id: s1Reject },
			T0 + 21,
		);
		expect(staleReject.response.status).toBe(409);
		expect(staleReject.html).toContain(
			"承認待ちの説明文が新しい内容へ更新されたため処理できませんでした",
		);
		expect((await loadAgent(grok.id)).description).toBe(
			"Published grok description",
		);
		expect(
			await queryChangeLog(db, { targetType: "description" }),
		).toHaveLength(0);
		expect((await loadPendingRow(grok.id))?.description).toBe(
			"Malicious D2 bio swapped before click",
		);

		// Extracting D2's fresh submission_id S2 from the refreshed screen and approving succeeds.
		const s2Approve = extractFormSubmissionId(
			staleApprove.html,
			grok.id,
			"approve",
		);
		expect(s2Approve).not.toBe(s1Approve);

		const freshApprove = await adminPost(
			`/admin/descriptions/${encodeURIComponent(grok.id)}/approve`,
			session,
			{ submission_id: s2Approve },
			T0 + 25,
		);
		expect(freshApprove.response.status).toBe(200);
		expect(freshApprove.html).toContain("説明文を承認して公開しました");
		expect((await loadAgent(grok.id)).description).toBe(
			"Malicious D2 bio swapped before click",
		);
		expect(await loadPendingRow(grok.id)).toBeNull();
		expect(
			await queryChangeLog(db, { targetType: "description" }),
		).toHaveLength(1);
	});

	it("displays description changes cleanly in /admin/rules and lets owner 1-click undo admin bot approvals in /admin/adminbot", async () => {
		await designateAdminBot(db, { agentId: muse.id, actor: OWNER, now: T0 });
		const sub = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "Bot-approved grok bio",
			now: T0 + 10,
		});
		if (!sub.ok) throw new Error("Expected submit to succeed");
		const botApprove = await approvePendingDescription(db, {
			agentId: grok.id,
			expectedSubmissionId: sub.data.pending.submissionId,
			actor: { actorType: "admin_bot", actorId: muse.id },
			now: T0 + 20,
		});
		if (!botApprove.ok) throw new Error("Expected approve to succeed");

		const { session } = await openDescriptionsSession(T0 + 30);
		const adminBotPage = await adminGet("/admin/adminbot", session, T0 + 30);
		expect(adminBotPage.response.status).toBe(200);
		expect(adminBotPage.html).toContain("説明文承認");
		expect(adminBotPage.html).toContain(
			`/admin/adminbot/changes/${botApprove.changeId}/revert`,
		);
		expect(adminBotPage.html).toContain("Published grok description");
		expect(adminBotPage.html).toContain("Bot-approved grok bio");

		// 1-click undo restores grok's previous description.
		const undone = await adminPost(
			`/admin/adminbot/changes/${botApprove.changeId}/revert`,
			session,
			{},
			T0 + 40,
		);
		expect(undone.response.status).toBe(200);
		expect(undone.html).toContain(
			`変更 #${botApprove.changeId}（説明文承認）を元に戻しました`,
		);
		expect((await loadAgent(grok.id)).description).toBe(
			"Published grok description",
		);

		// Even after deleting grok, /admin/rules resolves grok's name from historical description snapshots.
		await deleteAgent(db, { agentId: grok.id, actor: OWNER, now: T0 + 50 });
		const rulesPage = await adminGet("/admin/rules", session, T0 + 60);
		expect(rulesPage.response.status).toBe(200);
		expect(rulesPage.html).toContain("説明文承認");
		expect(rulesPage.html).toContain("変更取消");
		expect(rulesPage.html).toContain("grok");

		const changeLog = await queryChangeLog(db, { targetType: "description" });
		expect(changeLog.map((e) => e.action)).toEqual([
			"change_reverted",
			"description_approved",
		]);
	});
});
