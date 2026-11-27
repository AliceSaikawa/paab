import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { queryChangeLog } from "../../src/admin";
import {
	createProposal,
	designateAdminBot,
	handleAdminMcpRequest,
	submitPendingDescription,
} from "../../src/adminbot";
import { handleMcpRequest } from "../../src/mcp";
import {
	csrfCookieName,
	DEFAULT_ADMIN_ROUTES,
	encodeFlashValue,
	FLASH_COOKIE_NAME,
	handleAdminRequest,
	type UiEnv,
} from "../../src/ui";
import { handleUnreadRequest } from "../../src/unread";
import { createTestDb } from "../helpers/db";
import { seedAgent, seedCategory, T0 } from "../helpers/fixtures";
import { findSetCookie, TestCookieJar } from "../helpers/ui-cookies";
import { MCP_URL } from "../mcp/support";

const OWNER_EMAIL = "owner@example.com";
const HTTPS_ORIGIN = new URL("https://paab.test");
const HTTP_ORIGIN = new URL("http://localhost:8787");

let db: D1Database;

function devEnv(): UiEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "false",
		AUDIT_BODY_RETENTION_DAYS: "30",
		CF_ACCESS_TEAM_DOMAIN: "",
		CF_ACCESS_AUD: "",
		ADMIN_DEV_USER: OWNER_EMAIL,
	};
}

function extractTokenBox(htmlText: string): string {
	const match = /<div class="token-box">([^<]+)<\/div>/.exec(htmlText);
	if (!match?.[1]) {
		throw new Error("Expected token-box in secret display response");
	}
	return match[1];
}

function extractCsrfToken(htmlText: string): string {
	const match = /name="csrf_token" value="([^"]+)"/.exec(htmlText);
	if (!match?.[1]) {
		throw new Error("Expected hidden csrf_token input");
	}
	return match[1];
}

async function openJar(
	path: string,
	origin: URL = HTTPS_ORIGIN,
	now = T0,
): Promise<{ jar: TestCookieJar; csrfToken: string }> {
	const res = await handleAdminRequest(
		new Request(`${origin.origin}${path}`, { method: "GET" }),
		devEnv(),
		now,
	);
	expect(res.status).toBe(200);
	const jar = new TestCookieJar();
	jar.applyResponse(res);
	const csrfToken = jar.csrfToken(origin);
	if (!csrfToken) {
		throw new Error("Expected CSRF cookie on initial GET");
	}
	return { jar, csrfToken };
}

async function rawPost(
	path: string,
	jar: TestCookieJar,
	csrfToken: string,
	fields: Record<string, string> = {},
	origin: URL = HTTPS_ORIGIN,
	now = T0,
): Promise<Response> {
	return handleAdminRequest(
		new Request(`${origin.origin}${path}`, {
			method: "POST",
			headers: {
				Cookie: jar.header(),
				Origin: origin.origin,
			},
			body: new URLSearchParams({
				csrf_token: csrfToken,
				...fields,
			}),
		}),
		devEnv(),
		now,
	);
}

async function rawGet(
	path: string,
	jar: TestCookieJar,
	origin: URL = HTTPS_ORIGIN,
	now = T0,
): Promise<Response> {
	return handleAdminRequest(
		new Request(`${origin.origin}${path}`, {
			method: "GET",
			headers: jar.header() ? { Cookie: jar.header() } : {},
		}),
		devEnv(),
		now,
	);
}

async function mcpInit(
	url: string,
	token: string,
	handler: (req: Request, env: UiEnv, now: number) => Promise<Response>,
	now = T0,
): Promise<Response> {
	return handler(
		new Request(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "prg-test", version: "0.0.0" },
				},
			}),
		}),
		devEnv(),
		now,
	);
}

beforeEach(async () => {
	db = await createTestDb();
});

describe("Admin UI PRG redirects and flash cookie lifecycle", () => {
	it("redirects non-secret POSTs with 303 + flash cookie, displays notice once on GET, and clears cookie", async () => {
		const { jar, csrfToken } = await openJar("/admin/agents", HTTPS_ORIGIN, T0);

		const postRes = await rawPost(
			"/admin/agents",
			jar,
			csrfToken,
			{ name: "muse", description: "test", daily_question_limit: "10" },
			HTTPS_ORIGIN,
			T0 + 1,
		);
		expect(postRes.status).toBe(303);
		expect(postRes.headers.get("Location")).toBe("/admin/agents");
		expect(postRes.headers.get("Cache-Control")).toBe("no-store");
		const setFlash = findSetCookie(postRes, FLASH_COOKIE_NAME);
		expect(setFlash).toBeDefined();
		expect(setFlash).toContain("Path=/admin");
		expect(setFlash).toContain("Max-Age=60");
		expect(setFlash).toContain("HttpOnly");
		expect(setFlash).toContain("SameSite=Lax");
		expect(setFlash).toContain("Secure");
		jar.applyResponse(postRes);
		expect(jar.hasFlash()).toBe(true);

		// Following the 303 redirect renders the banner once and clears the flash cookie.
		const get1 = await rawGet("/admin/agents", jar, HTTPS_ORIGIN, T0 + 2);
		expect(get1.status).toBe(200);
		const clearFlash = findSetCookie(get1, FLASH_COOKIE_NAME);
		expect(clearFlash).toBeDefined();
		expect(clearFlash).toContain("Max-Age=0");
		expect(clearFlash).toContain("Path=/admin");
		expect(clearFlash).toContain("HttpOnly");
		expect(clearFlash).toContain("SameSite=Lax");
		expect(clearFlash).toContain("Secure");
		const html1 = await get1.text();
		expect(html1).toContain('class="banner banner-success"');
		expect(html1).toContain("エージェント「muse」を登録しました");
		jar.applyResponse(get1);
		expect(jar.hasFlash()).toBe(false);

		// Reloading /admin/agents does not show the banner again and emits no Set-Cookie.
		const get2 = await rawGet("/admin/agents", jar, HTTPS_ORIGIN, T0 + 3);
		expect(get2.status).toBe(200);
		expect(get2.headers.get("Set-Cookie")).toBeNull();
		const html2 = await get2.text();
		expect(html2).not.toContain("エージェント「muse」を登録しました");
	});

	it("omits Secure on HTTP localhost flash cookies and redirects across all admin sections", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const grok = await seedAgent(db, { name: "grok" });
		const schedule = await seedCategory(db, { name: "予定" });
		const owner = { actorType: "owner" as const, actorId: OWNER_EMAIL };
		await designateAdminBot(db, { agentId: muse.id, actor: owner, now: T0 });
		const proposal = await createProposal(db, {
			proposerAgentId: muse.id,
			payload: {
				kind: "grant_allow_rule",
				fromAgentId: muse.id,
				toAgentId: grok.id,
				categoryId: schedule.id,
			},
			reason: "ok",
			now: T0 + 1,
		});
		const sub = await submitPendingDescription(db, {
			agentId: grok.id,
			description: "updated bio",
			now: T0 + 2,
		});
		if (!proposal.ok || !sub.ok) throw new Error("Setup failed");

		const { jar, csrfToken } = await openJar("/admin/rules", HTTP_ORIGIN, T0);

		const cases: Array<{
			postPath: string;
			fields: Record<string, string>;
			expectedLocation: string;
			expectedText: string;
		}> = [
			{
				postPath: "/admin/categories",
				fields: { name: "仕事" },
				expectedLocation: "/admin/rules",
				expectedText: "カテゴリ「仕事」を追加しました。",
			},
			{
				postPath: `/admin/proposals/${encodeURIComponent(proposal.data.proposal.id)}/reject`,
				fields: {},
				expectedLocation: "/admin/proposals",
				expectedText: "提案を却下しました。",
			},
			{
				postPath: `/admin/descriptions/${encodeURIComponent(grok.id)}/approve`,
				fields: { submission_id: sub.data.pending.submissionId },
				expectedLocation: "/admin/descriptions",
				expectedText: "説明文を承認して公開しました",
			},
			{
				postPath: "/admin/adminbot/clear",
				fields: {},
				expectedLocation: "/admin/adminbot",
				expectedText: "管理者ボットの指名を解除しました",
			},
		];

		for (const [idx, testCase] of cases.entries()) {
			const postRes = await rawPost(
				testCase.postPath,
				jar,
				csrfToken,
				testCase.fields,
				HTTP_ORIGIN,
				T0 + 10 + idx,
			);
			expect(postRes.status, testCase.postPath).toBe(303);
			expect(postRes.headers.get("Location"), testCase.postPath).toBe(
				testCase.expectedLocation,
			);
			const flashCookie = findSetCookie(postRes, FLASH_COOKIE_NAME);
			expect(flashCookie, testCase.postPath).toContain("Path=/admin");
			expect(flashCookie, testCase.postPath).toContain("HttpOnly");
			expect(flashCookie, testCase.postPath).toContain("SameSite=Lax");
			expect(flashCookie, testCase.postPath).not.toContain("Secure");
			jar.applyResponse(postRes);

			const getRes = await rawGet(
				testCase.expectedLocation,
				jar,
				HTTP_ORIGIN,
				T0 + 20 + idx,
			);
			expect(getRes.status).toBe(200);
			const clearCookie = findSetCookie(getRes, FLASH_COOKIE_NAME);
			expect(clearCookie).toContain("Max-Age=0");
			expect(clearCookie).not.toContain("Secure");
			expect(await getRes.text()).toContain(testCase.expectedText);
			jar.applyResponse(getRes);
		}
	});

	it("escapes HTML in flash cookies and safely ignores + clears malformed flash cookies", async () => {
		const { jar } = await openJar("/admin/agents", HTTPS_ORIGIN, T0);
		const csrfHeader = jar.header();

		// Valid flash cookie containing HTML tags must be strictly escaped.
		const xssFlash = encodeFlashValue({
			kind: "error",
			message: '<script>alert("xss")</script>',
		});
		const escapedRes = await handleAdminRequest(
			new Request("https://paab.test/admin/agents", {
				method: "GET",
				headers: {
					Cookie: `${csrfHeader}; ${FLASH_COOKIE_NAME}=${xssFlash}`,
				},
			}),
			devEnv(),
			T0 + 1,
		);
		expect(escapedRes.status).toBe(200);
		expect(findSetCookie(escapedRes, FLASH_COOKIE_NAME)).toContain("Max-Age=0");
		const escapedHtml = await escapedRes.text();
		expect(escapedHtml).not.toContain('<script>alert("xss")</script>');
		expect(escapedHtml).toContain(
			"&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
		);

		// Malformed / invalid kind / oversized flash values are ignored and still cleared.
		const invalidKind = btoa(
			JSON.stringify({ kind: 'error" onclick="alert(1)', message: "hi" }),
		)
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replaceAll("=", "");
		for (const badCookieValue of [
			"not-valid-base64!!!",
			invalidKind,
			"A".repeat(4000),
		]) {
			const res = await handleAdminRequest(
				new Request("https://paab.test/admin/agents", {
					method: "GET",
					headers: {
						Cookie: `${csrfHeader}; ${FLASH_COOKIE_NAME}=${badCookieValue}`,
					},
				}),
				devEnv(),
				T0 + 2,
			);
			expect(res.status).toBe(200);
			expect(findSetCookie(res, FLASH_COOKIE_NAME)).toContain("Max-Age=0");
			const html = await res.text();
			expect(html).not.toContain('class="banner banner-error"');
			expect(html).not.toContain("onclick=");
			expect(html).not.toContain(">hi<");
		}
	});
});

describe("One-time secret POST replay protection via CSRF rotation", () => {
	it("protects participant token issue/reissue from browser reload replay without revoking the displayed token", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const { jar, csrfToken: staleCsrf } = await openJar(
			"/admin/agents",
			HTTPS_ORIGIN,
			T0,
		);

		const issueRes = await rawPost(
			`/admin/agents/${muse.id}/token`,
			jar,
			staleCsrf,
			{},
			HTTPS_ORIGIN,
			T0 + 1,
		);
		expect(issueRes.status).toBe(200);
		expect(issueRes.headers.get("Cache-Control")).toBe("no-store");
		const rotatedHeader = findSetCookie(issueRes, csrfCookieName(HTTPS_ORIGIN));
		expect(rotatedHeader).toBeDefined();
		const issueHtml = await issueRes.text();
		const issuedToken = extractTokenBox(issueHtml);
		expect(rotatedHeader).not.toContain(issuedToken);

		jar.applyResponse(issueRes);
		const rotatedCsrf = jar.csrfToken(HTTPS_ORIGIN);
		expect(rotatedCsrf).toBeTruthy();
		expect(rotatedCsrf).not.toBe(staleCsrf);

		const logsBeforeReplay = await queryChangeLog(db);

		// Simulate browser reload: resends the exact same form body (staleCsrf) with the updated cookie jar.
		const replayRes = await rawPost(
			`/admin/agents/${muse.id}/token`,
			jar,
			staleCsrf,
			{},
			HTTPS_ORIGIN,
			T0 + 2,
		);
		expect(replayRes.status).toBe(303);
		expect(replayRes.headers.get("Location")).toBe("/admin/agents");
		expect(findSetCookie(replayRes, FLASH_COOKIE_NAME)).toBeDefined();
		jar.applyResponse(replayRes);

		// Previously shown token MUST still work on /mcp and no extra change_log row was written.
		expect(
			(await mcpInit(MCP_URL, issuedToken, handleMcpRequest, T0 + 3)).status,
		).toBe(200);
		expect(await queryChangeLog(db)).toHaveLength(logsBeforeReplay.length);

		// Following the redirect shows the warning notice and gives forms the newly rotated CSRF token.
		const afterReplay = await rawGet(
			"/admin/agents",
			jar,
			HTTPS_ORIGIN,
			T0 + 4,
		);
		expect(afterReplay.status).toBe(200);
		const afterHtml = await afterReplay.text();
		expect(afterHtml).toContain(
			'<div class="banner banner-warning" role="status">このフォームはすでに送信済み',
		);
		expect(afterHtml).toContain("そのまま有効です");
		expect(extractCsrfToken(afterHtml)).toBe(rotatedCsrf);
	});

	it("protects unread_count token issue from reload replay without revoking the displayed token", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const { jar, csrfToken: staleCsrf } = await openJar(
			"/admin/agents",
			HTTPS_ORIGIN,
			T0,
		);

		const issueRes = await rawPost(
			`/admin/agents/${muse.id}/unread-token`,
			jar,
			staleCsrf,
			{},
			HTTPS_ORIGIN,
			T0 + 1,
		);
		expect(issueRes.status).toBe(200);
		expect(issueRes.headers.get("Cache-Control")).toBe("no-store");
		const unreadToken = extractTokenBox(await issueRes.text());
		jar.applyResponse(issueRes);
		expect(jar.csrfToken(HTTPS_ORIGIN)).not.toBe(staleCsrf);

		const logsBeforeReplay = await queryChangeLog(db);
		const replayRes = await rawPost(
			`/admin/agents/${muse.id}/unread-token`,
			jar,
			staleCsrf,
			{},
			HTTPS_ORIGIN,
			T0 + 2,
		);
		expect(replayRes.status).toBe(303);
		expect(replayRes.headers.get("Location")).toBe("/admin/agents");
		expect(await queryChangeLog(db)).toHaveLength(logsBeforeReplay.length);

		// Displayed unread_count token still works on GET /unread.
		const unreadRes = await handleUnreadRequest(
			new Request("https://paab.test/unread", {
				method: "GET",
				headers: { Authorization: `Bearer ${unreadToken}` },
			}),
			devEnv(),
			T0 + 3,
		);
		expect(unreadRes.status).toBe(200);
	});

	it("protects admin bot token issue from reload replay without revoking the displayed token", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		await designateAdminBot(db, {
			agentId: muse.id,
			actor: { actorType: "owner", actorId: OWNER_EMAIL },
			now: T0,
		});
		const { jar, csrfToken: staleCsrf } = await openJar(
			"/admin/adminbot",
			HTTPS_ORIGIN,
			T0 + 1,
		);

		const issueRes = await rawPost(
			"/admin/adminbot/token",
			jar,
			staleCsrf,
			{ agent_id: muse.id },
			HTTPS_ORIGIN,
			T0 + 2,
		);
		expect(issueRes.status).toBe(200);
		expect(issueRes.headers.get("Cache-Control")).toBe("no-store");
		const adminToken = extractTokenBox(await issueRes.text());
		jar.applyResponse(issueRes);
		expect(jar.csrfToken(HTTPS_ORIGIN)).not.toBe(staleCsrf);

		const logsBeforeReplay = await queryChangeLog(db);
		const replayRes = await rawPost(
			"/admin/adminbot/token",
			jar,
			staleCsrf,
			{ agent_id: muse.id },
			HTTPS_ORIGIN,
			T0 + 3,
		);
		expect(replayRes.status).toBe(303);
		expect(replayRes.headers.get("Location")).toBe("/admin/adminbot");
		expect(await queryChangeLog(db)).toHaveLength(logsBeforeReplay.length);

		expect(
			(
				await mcpInit(
					"https://paab.test/mcp/admin",
					adminToken,
					handleAdminMcpRequest,
					T0 + 4,
				)
			).status,
		).toBe(200);
	});

	it("protects paab_hmac webhook creation and rotation from reload replay without replacing the displayed secret", async () => {
		const muse = await seedAgent(db, { name: "muse" });
		const { jar, csrfToken: createCsrf } = await openJar(
			"/admin/agents",
			HTTPS_ORIGIN,
			T0,
		);

		// 1. Create paab_hmac webhook -> reveals secret once and rotates CSRF cookie.
		const createRes = await rawPost(
			`/admin/agents/${muse.id}/webhook`,
			jar,
			createCsrf,
			{
				url: "https://receiver.example.com/hook",
				auth_mode: "paab_hmac",
				secret: "",
			},
			HTTPS_ORIGIN,
			T0 + 1,
		);
		expect(createRes.status).toBe(200);
		expect(createRes.headers.get("Cache-Control")).toBe("no-store");
		const createSecret = extractTokenBox(await createRes.text());
		const createCookie = findSetCookie(createRes, csrfCookieName(HTTPS_ORIGIN));
		expect(createCookie).toBeDefined();
		expect(createCookie).not.toContain(createSecret);
		jar.applyResponse(createRes);

		const storedAfterCreate = await db
			.prepare("SELECT secret FROM agent_webhooks WHERE agent_id = ?")
			.bind(muse.id)
			.first<{ secret: string }>();
		expect(storedAfterCreate?.secret).toBe(createSecret);
		const logsAfterCreate = await queryChangeLog(db);

		// Replay create POST -> rejected via 303 without replacing the secret.
		const replayCreate = await rawPost(
			`/admin/agents/${muse.id}/webhook`,
			jar,
			createCsrf,
			{
				url: "https://receiver.example.com/hook",
				auth_mode: "paab_hmac",
				secret: "",
			},
			HTTPS_ORIGIN,
			T0 + 2,
		);
		expect(replayCreate.status).toBe(303);
		expect(replayCreate.headers.get("Location")).toBe("/admin/agents");
		expect(await queryChangeLog(db)).toHaveLength(logsAfterCreate.length);
		const storedAfterCreateReplay = await db
			.prepare("SELECT secret FROM agent_webhooks WHERE agent_id = ?")
			.bind(muse.id)
			.first<{ secret: string }>();
		expect(storedAfterCreateReplay?.secret).toBe(createSecret);

		// 2. Navigate back via GET to get fresh CSRF token, then rotate paab_hmac secret.
		jar.applyResponse(replayCreate);
		const backRes = await rawGet("/admin/agents", jar, HTTPS_ORIGIN, T0 + 3);
		jar.applyResponse(backRes);
		const rotateCsrf = extractCsrfToken(await backRes.text());

		const rotateRes = await rawPost(
			`/admin/agents/${muse.id}/webhook/rotate`,
			jar,
			rotateCsrf,
			{},
			HTTPS_ORIGIN,
			T0 + 4,
		);
		expect(rotateRes.status).toBe(200);
		expect(rotateRes.headers.get("Cache-Control")).toBe("no-store");
		const rotatedSecret = extractTokenBox(await rotateRes.text());
		expect(rotatedSecret).not.toBe(createSecret);
		jar.applyResponse(rotateRes);

		const logsAfterRotate = await queryChangeLog(db);

		// Replay rotate POST -> rejected via 303 without rotating a second time.
		const replayRotate = await rawPost(
			`/admin/agents/${muse.id}/webhook/rotate`,
			jar,
			rotateCsrf,
			{},
			HTTPS_ORIGIN,
			T0 + 5,
		);
		expect(replayRotate.status).toBe(303);
		expect(replayRotate.headers.get("Location")).toBe("/admin/agents");
		expect(await queryChangeLog(db)).toHaveLength(logsAfterRotate.length);
		const storedAfterRotateReplay = await db
			.prepare("SELECT secret FROM agent_webhooks WHERE agent_id = ?")
			.bind(muse.id)
			.first<{ secret: string }>();
		expect(storedAfterRotateReplay?.secret).toBe(rotatedSecret);
	});
});

describe("GET/HEAD fallback on POST-only admin routes", () => {
	const postOnlyExpectations: ReadonlyArray<
		readonly [path: string, expectedLocation: string]
	> = [
		["/admin/agents/agent-1/update", "/admin/agents"],
		["/admin/agents/agent-1/suspend", "/admin/agents"],
		["/admin/agents/agent-1/resume", "/admin/agents"],
		["/admin/agents/agent-1/token", "/admin/agents"],
		["/admin/agents/agent-1/token/revoke", "/admin/agents"],
		["/admin/agents/agent-1/unread-token", "/admin/agents"],
		["/admin/agents/agent-1/unread-token/revoke", "/admin/agents"],
		["/admin/agents/agent-1/webhook", "/admin/agents"],
		["/admin/agents/agent-1/webhook/rotate", "/admin/agents"],
		["/admin/agents/agent-1/webhook/delete", "/admin/agents"],
		["/admin/rules/grant", "/admin/rules"],
		["/admin/rules/revoke", "/admin/rules"],
		["/admin/categories", "/admin/rules"],
		["/admin/categories/", "/admin/rules"],
		["/admin/proposals/prop-1/approve", "/admin/proposals"],
		["/admin/proposals/prop-1/reject", "/admin/proposals"],
		["/admin/descriptions/agent-1/approve", "/admin/descriptions"],
		["/admin/descriptions/agent-1/reject", "/admin/descriptions"],
		["/admin/adminbot/designate", "/admin/adminbot"],
		["/admin/adminbot/clear", "/admin/adminbot"],
		["/admin/adminbot/token", "/admin/adminbot"],
		["/admin/adminbot/token/revoke", "/admin/adminbot"],
		["/admin/adminbot/permissions/read-bodies", "/admin/adminbot"],
		["/admin/adminbot/permissions/superadmin", "/admin/adminbot"],
		["/admin/adminbot/changes/42/revert", "/admin/adminbot"],
	];

	it("ensures every POST-only route in DEFAULT_ADMIN_ROUTES declares a fallbackPath", () => {
		const postOnlyRoutes = DEFAULT_ADMIN_ROUTES.filter(
			(route) => route.post !== undefined && route.get === undefined,
		);
		expect(postOnlyRoutes.length).toBeGreaterThan(0);
		for (const route of postOnlyRoutes) {
			expect(route.fallbackPath, route.pattern).toMatch(/^\/admin(\/|$)/);
		}
	});

	it("redirects GET and HEAD on every POST-only route to its parent page instead of returning 405", async () => {
		for (const [path, expectedLocation] of postOnlyExpectations) {
			const getRes = await handleAdminRequest(
				new Request(`https://paab.test${path}`, { method: "GET" }),
				devEnv(),
				T0,
			);
			expect(getRes.status, `GET ${path}`).toBe(303);
			expect(getRes.headers.get("Location"), `GET ${path}`).toBe(
				expectedLocation,
			);
			expect(getRes.headers.get("Cache-Control"), `GET ${path}`).toBe(
				"no-store",
			);

			const headRes = await handleAdminRequest(
				new Request(`https://paab.test${path}`, { method: "HEAD" }),
				devEnv(),
				T0,
			);
			expect(headRes.status, `HEAD ${path}`).toBe(303);
			expect(headRes.headers.get("Location"), `HEAD ${path}`).toBe(
				expectedLocation,
			);
			expect(await headRes.text(), `HEAD ${path}`).toBe("");
		}
	});

	it("does not consume a pending flash cookie on POST-only GET redirect or HEAD request", async () => {
		const { jar } = await openJar("/admin/agents", HTTPS_ORIGIN, T0);
		const flashValue = encodeFlashValue({
			kind: "info",
			message: "保留中の通知",
		});
		const cookieHeader = `${jar.header()}; ${FLASH_COOKIE_NAME}=${flashValue}`;

		const redirectRes = await handleAdminRequest(
			new Request("https://paab.test/admin/agents/agent-1/token", {
				method: "GET",
				headers: { Cookie: cookieHeader },
			}),
			devEnv(),
			T0 + 1,
		);
		expect(redirectRes.status).toBe(303);
		expect(findSetCookie(redirectRes, FLASH_COOKIE_NAME)).toBeUndefined();

		const headRes = await handleAdminRequest(
			new Request("https://paab.test/admin/agents", {
				method: "HEAD",
				headers: { Cookie: cookieHeader },
			}),
			devEnv(),
			T0 + 2,
		);
		expect(headRes.status).toBe(200);
		expect(findSetCookie(headRes, FLASH_COOKIE_NAME)).toBeUndefined();

		const getRes = await handleAdminRequest(
			new Request("https://paab.test/admin/agents", {
				method: "GET",
				headers: { Cookie: cookieHeader },
			}),
			devEnv(),
			T0 + 3,
		);
		expect(getRes.status).toBe(200);
		expect(findSetCookie(getRes, FLASH_COOKIE_NAME)).toContain("Max-Age=0");
		expect(await getRes.text()).toContain("保留中の通知");
	});

	it("still returns 405 for PUT/DELETE on POST-only routes and POST on GET-only routes", async () => {
		for (const method of ["PUT", "DELETE"]) {
			const res = await handleAdminRequest(
				new Request("https://paab.test/admin/agents/agent-1/token", {
					method,
				}),
				devEnv(),
				T0,
			);
			expect(res.status, method).toBe(405);
		}

		const { jar, csrfToken } = await openJar("/admin/audit", HTTPS_ORIGIN, T0);
		const postAudit = await rawPost(
			"/admin/audit",
			jar,
			csrfToken,
			{},
			HTTPS_ORIGIN,
			T0 + 1,
		);
		expect(postAudit.status).toBe(405);
	});
});
