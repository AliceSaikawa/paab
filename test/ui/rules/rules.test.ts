import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	listAllowRulesGrouped,
	listCategoriesWithUsage,
	queryChangeLog,
} from "../../../src/admin";
import { queryAuditLog } from "../../../src/audit";
import { issueToken } from "../../../src/auth";
import { handleAdminRequest, type UiEnv } from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { seedAgent, seedCategory, T0 } from "../../helpers/fixtures";
import { call, connect, withoutFooter } from "../../mcp/support";

const OWNER_EMAIL = "owner@example.com";

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
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

async function openRulesSession(now = T0): Promise<{
	session: CsrfSession;
	response: Response;
	html: string;
}> {
	const response = await handleAdminRequest(
		new Request("https://localhost/admin/rules", { method: "GET" }),
		devEnv(),
		now,
	);
	const setCookie = response.headers.get("Set-Cookie") ?? "";
	const cookie = setCookie.split(";", 1)[0] ?? "";
	const html = await response.text();
	const tokenMatch = /name="csrf_token" value="([^"]+)"/.exec(html);
	if (!cookie || !tokenMatch?.[1]) {
		throw new Error("Expected CSRF cookie and hidden token on /admin/rules");
	}
	return {
		session: { cookie, token: tokenMatch[1] },
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
		new Request(`https://localhost${path}`, {
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
	fields: Record<string, string>,
	now = T0,
): Promise<Response> {
	return handleAdminRequest(
		new Request(`https://localhost${path}`, {
			method: "POST",
			headers: {
				Cookie: session.cookie,
				Origin: "https://localhost",
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

describe("GET /admin/rules", () => {
	it("renders directional rules, grant form with その他 advisory, categories, and CSP without extra scripts", async () => {
		const muse = await seedAgent(db, { name: "muse", status: "active" });
		const grok = await seedAgent(db, { name: "grok", status: "suspended" });
		const work = await seedCategory(db, { name: "仕事" });
		await seedCategory(db, { name: "予定" });
		const other = await seedCategory(db, { name: "その他" });

		const { session, response: initialRes } = await openRulesSession(T0);
		expect(initialRes.status).toBe(200);

		const grantRes = await adminPost(
			"/admin/rules/grant",
			session,
			{
				from_agent_id: muse.id,
				to_agent_id: grok.id,
				category_id: work.id,
			},
			T0 + 100,
		);
		expect(grantRes.status).toBe(200);

		const res = await adminGet("/admin/rules", session, T0 + 200);
		expect(res.status).toBe(200);
		const html = await res.text();

		expect(html).toContain('href="/admin/rules" aria-current="page"');
		expect(html).toContain(
			"A → B を許可しても、B → A は自動では許可されません",
		);
		expect(html).toContain("muse");
		expect(html).toContain("grok");
		expect(html).toContain("停止中");
		expect(html).toContain('action="/admin/rules/revoke"');
		expect(html).toContain('action="/admin/rules/grant"');
		expect(html).toContain("設計書 3.2");
		expect(html).toContain("その他");
		expect(html).toContain("初期状態");
		expect(html).toContain(`value="${other.id}"`);
		expect(html).toContain(
			`href="/admin/categories/${encodeURIComponent(work.id)}/delete"`,
		);

		const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
		expect(scripts).toHaveLength(1);
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		const expectedHash = await sha256HeaderValue(scripts[0]?.[1] ?? "");
		expect(csp).toContain(`script-src '${expectedHash}'`);
	});

	it("keeps /admin/rules fail-closed via SELF.fetch when Access is unconfigured", async () => {
		const res = await SELF.fetch("https://paab.test/admin/rules");
		expect(res.status).toBe(503);
	});
});

describe("Allow rules lifecycle via /admin/rules and MCP tools", () => {
	it("grants a directional rule (including その他) for list_agents and ask, keeps reverse blocked, and blocks after revoke", async () => {
		const alice = await seedAgent(db, { name: "alice" });
		const bob = await seedAgent(db, { name: "bob" });
		const work = await seedCategory(db, { name: "仕事" });
		const other = await seedCategory(db, { name: "その他" });

		const aliceTok = await issueToken(db, {
			agentId: alice.id,
			purpose: "participant",
			now: T0,
		});
		const bobTok = await issueToken(db, {
			agentId: bob.id,
			purpose: "participant",
			now: T0,
		});

		const aliceClient = await connect(aliceTok.token, { now: T0 });
		const bobClient = await connect(bobTok.token, { now: T0 });

		expect(withoutFooter((await call(aliceClient, "list_agents")).text)).toBe(
			"no agents you may ask",
		);

		const { session } = await openRulesSession(T0);
		const grantWork = await adminPost(
			"/admin/rules/grant",
			session,
			{
				from_agent_id: alice.id,
				to_agent_id: bob.id,
				category_id: work.id,
			},
			T0 + 1000,
		);
		expect(grantWork.status).toBe(200);
		expect(await grantWork.text()).toContain("許可ルールを追加しました");

		const aliceList = withoutFooter(
			(await call(aliceClient, "list_agents")).text,
		);
		expect(aliceList).toContain("name: bob");
		expect(aliceList).toContain("categories: 仕事");

		const askWork = await call(aliceClient, "ask", {
			to: "bob",
			category: "仕事",
			question: "今週の予定は？",
		});
		expect(askWork.isError).toBe(false);

		const bobInbox1 = withoutFooter(
			(await call(bobClient, "check_inbox")).text,
		);
		expect(bobInbox1).toContain("kind: question");
		expect(bobInbox1).toContain("from: alice");
		expect(bobInbox1).toContain("category: 仕事");
		expect(bobInbox1).toContain("今週の予定は？");

		// Opposite direction bob -> alice remains disallowed.
		expect(withoutFooter((await call(bobClient, "list_agents")).text)).toBe(
			"no agents you may ask",
		);
		await call(bobClient, "ask", {
			to: "alice",
			category: "仕事",
			question: "逆向きは通りますか？",
		});
		expect(withoutFooter((await call(aliceClient, "check_inbox")).text)).toBe(
			"no new messages",
		);
		expect(
			withoutFooter((await call(bobClient, "check_inbox")).text),
		).toContain("kind: rejection");

		// Advisory notice does not block granting "その他".
		const grantOther = await adminPost(
			"/admin/rules/grant",
			session,
			{
				from_agent_id: alice.id,
				to_agent_id: bob.id,
				category_id: other.id,
			},
			T0 + 2000,
		);
		expect(grantOther.status).toBe(200);

		const aliceListWithOther = withoutFooter(
			(await call(aliceClient, "list_agents")).text,
		);
		expect(aliceListWithOther).toContain("categories: その他, 仕事");

		await call(aliceClient, "ask", {
			to: "bob",
			category: "その他",
			question: "雑談ですが確認です",
		});
		const bobInboxOther = withoutFooter(
			(await call(bobClient, "check_inbox")).text,
		);
		expect(bobInboxOther).toContain("category: その他");
		expect(bobInboxOther).toContain("雑談ですが確認です");

		// Revoking alice -> bob (仕事) immediately blocks the next ask.
		const revokeWork = await adminPost(
			"/admin/rules/revoke",
			session,
			{
				from_agent_id: alice.id,
				to_agent_id: bob.id,
				category_id: work.id,
			},
			T0 + 3000,
		);
		expect(revokeWork.status).toBe(200);
		expect(await revokeWork.text()).toContain("許可ルールを取り消しました");

		const aliceListAfterRevoke = withoutFooter(
			(await call(aliceClient, "list_agents")).text,
		);
		expect(aliceListAfterRevoke).toContain("categories: その他");
		expect(aliceListAfterRevoke).not.toContain("仕事");

		await call(aliceClient, "ask", {
			to: "bob",
			category: "仕事",
			question: "取り消し後の質問",
		});
		expect(withoutFooter((await call(bobClient, "check_inbox")).text)).toBe(
			"no new messages",
		);
		expect(
			withoutFooter((await call(aliceClient, "check_inbox")).text),
		).toContain("kind: rejection");

		const blockedAudits = (
			await queryAuditLog(db, {
				outcome: "denied",
			})
		).filter((a) => a.eventType === "question_blocked");
		expect(blockedAudits).toHaveLength(2);
		expect(blockedAudits.every((a) => a.reasonCode === "no_allow_rule")).toBe(
			true,
		);
	});
});

describe("Categories lifecycle and delete confirmation", () => {
	it("creates a category, shows exact allowRuleCount on confirmation GET, and deletes category + rules on POST", async () => {
		const alice = await seedAgent(db, { name: "alice" });
		const bob = await seedAgent(db, { name: "bob" });
		const aliceTok = await issueToken(db, {
			agentId: alice.id,
			purpose: "participant",
			now: T0,
		});

		const { session } = await openRulesSession(T0);

		const createRes = await adminPost(
			"/admin/categories",
			session,
			{ name: "  健康  " },
			T0 + 1000,
		);
		expect(createRes.status).toBe(200);
		const createHtml = await createRes.text();
		expect(createHtml).toContain("カテゴリ「健康」を追加しました");

		const cats = await listCategoriesWithUsage(db);
		expect(cats).toHaveLength(1);
		const health = cats[0]?.category;
		expect(health?.name).toBe("健康");
		if (!health) return;

		await adminPost(
			"/admin/rules/grant",
			session,
			{
				from_agent_id: alice.id,
				to_agent_id: bob.id,
				category_id: health.id,
			},
			T0 + 2000,
		);
		await adminPost(
			"/admin/rules/grant",
			session,
			{
				from_agent_id: bob.id,
				to_agent_id: alice.id,
				category_id: health.id,
			},
			T0 + 3000,
		);

		const confirmRes = await adminGet(
			`/admin/categories/${encodeURIComponent(health.id)}/delete`,
			session,
			T0 + 4000,
		);
		expect(confirmRes.status).toBe(200);
		const confirmHtml = await confirmRes.text();
		expect(confirmHtml).toContain("カテゴリ「健康」を削除しますか？");
		expect(confirmHtml).toContain(
			"このカテゴリを使っている許可ルール 2 件も同時に削除されます",
		);
		expect(confirmHtml).toContain(
			`action="/admin/categories/${encodeURIComponent(health.id)}/delete"`,
		);

		// Navigating to the confirmation page must not delete anything yet.
		expect(await listAllowRulesGrouped(db)).toHaveLength(2);

		const deleteRes = await adminPost(
			`/admin/categories/${encodeURIComponent(health.id)}/delete`,
			session,
			{},
			T0 + 5000,
		);
		expect(deleteRes.status).toBe(200);
		const deleteHtml = await deleteRes.text();
		expect(deleteHtml).toContain(
			"カテゴリ「健康」を削除しました（許可ルール 2 件も削除）",
		);
		expect(await listCategoriesWithUsage(db)).toEqual([]);
		expect(await listAllowRulesGrouped(db)).toEqual([]);

		const aliceClient = await connect(aliceTok.token, { now: T0 + 6000 });
		await call(aliceClient, "ask", {
			to: "bob",
			category: "健康",
			question: "体調はどうですか？",
		});
		const audits = await queryAuditLog(db, { outcome: "denied" });
		expect(audits[0]?.eventType).toBe("question_blocked");
		expect(audits[0]?.reasonCode).toBe("category_not_found");
	});

	it("returns 404 for deleting a missing category on GET and POST", async () => {
		const { session } = await openRulesSession(T0);

		const getMissing = await adminGet(
			"/admin/categories/missing-id/delete",
			session,
		);
		expect(getMissing.status).toBe(404);
		expect(await getMissing.text()).toContain("カテゴリが見つかりません");

		const postMissing = await adminPost(
			"/admin/categories/missing-id/delete",
			session,
			{},
		);
		expect(postMissing.status).toBe(404);
	});
});

describe("change_log ordering, validation errors, CSRF, and XSS escaping", () => {
	it("records all mutations with owner email and shows them newest-first in change_log and on /admin/rules", async () => {
		const alice = await seedAgent(db, { name: "alice" });
		const bob = await seedAgent(db, { name: "bob" });
		const { session } = await openRulesSession(T0);

		await adminPost("/admin/categories", session, { name: "仕事" }, T0 + 1000);
		const workCat = (await listCategoriesWithUsage(db)).find(
			(c) => c.category.name === "仕事",
		)?.category;
		expect(workCat).toBeDefined();
		if (!workCat) return;

		await adminPost(
			"/admin/rules/grant",
			session,
			{
				from_agent_id: alice.id,
				to_agent_id: bob.id,
				category_id: workCat.id,
			},
			T0 + 2000,
		);
		await adminPost(
			"/admin/rules/revoke",
			session,
			{
				from_agent_id: alice.id,
				to_agent_id: bob.id,
				category_id: workCat.id,
			},
			T0 + 3000,
		);
		await adminPost("/admin/categories", session, { name: "予定" }, T0 + 4000);
		await adminPost(
			`/admin/categories/${encodeURIComponent(workCat.id)}/delete`,
			session,
			{},
			T0 + 5000,
		);

		const logs = await queryChangeLog(db);
		expect(logs.map((e) => e.action)).toEqual([
			"category_deleted",
			"category_created",
			"allow_rule_revoked",
			"allow_rule_granted",
			"category_created",
		]);
		expect(logs.every((e) => e.actorType === "owner")).toBe(true);
		expect(logs.every((e) => e.actorId === OWNER_EMAIL)).toBe(true);

		const pageRes = await adminGet("/admin/rules", session, T0 + 6000);
		expect(pageRes.status).toBe(200);
		const html = await pageRes.text();

		const historySection = html.split("変更履歴（change_log）")[1] ?? "";
		expect(historySection).toContain(`所有者: ${OWNER_EMAIL}`);
		expect(historySection).toContain("<time datetime=");

		const t5 = historySection.indexOf(new Date(T0 + 5000).toISOString());
		const t4 = historySection.indexOf(new Date(T0 + 4000).toISOString());
		const t3 = historySection.indexOf(new Date(T0 + 3000).toISOString());
		const t2 = historySection.indexOf(new Date(T0 + 2000).toISOString());
		const t1 = historySection.indexOf(new Date(T0 + 1000).toISOString());
		expect(t5).toBeGreaterThan(-1);
		expect(t5).toBeLessThan(t4);
		expect(t4).toBeLessThan(t3);
		expect(t3).toBeLessThan(t2);
		expect(t2).toBeLessThan(t1);

		expect(historySection).toContain("カテゴリ削除");
		expect(historySection).toContain("許可ルール取消");
		expect(historySection).toContain("許可ルール追加");
		expect(historySection).toContain("カテゴリ追加");
		expect(historySection).toContain("alice → bob (仕事)");
	});

	it("rejects invalid inputs, duplicate rules, invalid CSRF, and escapes HTML in names", async () => {
		const alice = await seedAgent(db, { name: "alice" });
		const bob = await seedAgent(db, { name: "bob" });
		const work = await seedCategory(db, { name: "仕事" });
		const { session } = await openRulesSession(T0);

		const selfRule = await adminPost("/admin/rules/grant", session, {
			from_agent_id: alice.id,
			to_agent_id: alice.id,
			category_id: work.id,
		});
		expect(selfRule.status).toBe(400);
		expect(await selfRule.text()).toContain("自分自身への質問を許可するルール");

		await adminPost("/admin/rules/grant", session, {
			from_agent_id: alice.id,
			to_agent_id: bob.id,
			category_id: work.id,
		});
		const duplicateRule = await adminPost("/admin/rules/grant", session, {
			from_agent_id: alice.id,
			to_agent_id: bob.id,
			category_id: work.id,
		});
		expect(duplicateRule.status).toBe(409);
		expect(await duplicateRule.text()).toContain(
			"同じ許可ルールがすでに存在します",
		);

		const badCategory = await adminPost("/admin/categories", session, {
			name: "a,b",
		});
		expect(badCategory.status).toBe(400);
		expect(await badCategory.text()).toContain("カンマ");

		const dupCategory = await adminPost("/admin/categories", session, {
			name: " 仕事 ",
		});
		expect(dupCategory.status).toBe(409);

		const xssRes = await adminPost(
			"/admin/categories",
			session,
			{ name: "<script>alert(1)</script>" },
			T0 + 100,
		);
		expect(xssRes.status).toBe(200);
		const xssHtml = await xssRes.text();
		expect(xssHtml).not.toContain("<script>alert(1)</script>");
		expect(xssHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

		// CSRF missing token is rejected with 403 on every POST endpoint.
		for (const path of [
			"/admin/rules/grant",
			"/admin/rules/revoke",
			"/admin/categories",
			`/admin/categories/${work.id}/delete`,
		]) {
			const noCsrf = await handleAdminRequest(
				new Request(`https://localhost${path}`, {
					method: "POST",
					headers: {
						Cookie: session.cookie,
						Origin: "https://localhost",
					},
					body: new URLSearchParams({ name: "x" }),
				}),
				devEnv(),
				T0,
			);
			expect(noCsrf.status).toBe(403);
		}
	});
});
