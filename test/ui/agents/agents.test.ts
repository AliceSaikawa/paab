import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { grantAllowRule, queryChangeLog } from "../../../src/admin";
import { hashToken } from "../../../src/auth";
import { insertMessage, newId } from "../../../src/db";
import { handleMcpRequest } from "../../../src/mcp";
import {
	csrfCookieName,
	FLASH_COOKIE_NAME,
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { DAY_MS, HOUR_MS, seedCategory, T0 } from "../../helpers/fixtures";
import { findSetCookie, TestCookieJar } from "../../helpers/ui-cookies";
import { call, connect, MCP_URL } from "../../mcp/support";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "agents-ui-aud";
const ADMIN_EMAIL = "owner-admin@example.com";

interface SigningKeyPair {
	kid: string;
	privateKey: CryptoKey;
	jwk: JwkKey;
}

let signingKey: SigningKeyPair;
let db: D1Database;

function toBase64Url(input: Uint8Array | string): string {
	const bytes =
		typeof input === "string" ? new TextEncoder().encode(input) : input;
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

async function generateSigningKey(kid: string): Promise<SigningKeyPair> {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	if (!("publicKey" in pair)) {
		throw new Error("Expected RSA key pair");
	}
	const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
	if (exported instanceof ArrayBuffer) {
		throw new Error("Expected JWK export");
	}
	return {
		kid,
		privateKey: pair.privateKey,
		jwk: {
			kty: exported.kty,
			n: exported.n,
			e: exported.e,
			alg: "RS256",
			use: "sig",
			kid,
		},
	};
}

async function signAccessJwt(email: string, now = T0): Promise<string> {
	const nowSec = Math.floor(now / 1000);
	const headerB64 = toBase64Url(
		JSON.stringify({ alg: "RS256", typ: "JWT", kid: signingKey.kid }),
	);
	const payloadB64 = toBase64Url(
		JSON.stringify({
			aud: TEST_AUD,
			exp: nowSec + 24 * 3600,
			nbf: nowSec - 10,
			email,
			sub: `sub-${email}`,
		}),
	);
	const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		signingKey.privateKey,
		signingInput,
	);
	return `${headerB64}.${payloadB64}.${toBase64Url(new Uint8Array(signature))}`;
}

function accessEnv(): UiEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "false",
		AUDIT_BODY_RETENTION_DAYS: "30",
		CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		CF_ACCESS_AUD: TEST_AUD,
	};
}

function jwksFetcher(): JwksFetcher {
	const doc = { keys: [signingKey.jwk] };
	return vi.fn(async () => doc);
}

const ADMIN_ORIGIN = new URL("https://paab.test");

interface AdminSession {
	jar: TestCookieJar;
	cookie: string;
	csrfToken: string;
	jwt: string;
	fetcher: JwksFetcher;
}

function syncSession(session: AdminSession): void {
	session.cookie = session.jar.header();
	const token = session.jar.csrfToken(ADMIN_ORIGIN);
	if (token !== undefined) {
		session.csrfToken = token;
	}
}

function extractCsrfToken(htmlText: string): string {
	const match = /name="csrf_token" value="([^"]+)"/.exec(htmlText);
	if (!match?.[1]) {
		throw new Error("Could not find csrf_token in HTML response");
	}
	return match[1];
}

async function openAdminSession(
	email = ADMIN_EMAIL,
	now = T0,
): Promise<{ session: AdminSession; response: Response; html: string }> {
	const jwt = await signAccessJwt(email, now);
	const fetcher = jwksFetcher();
	const response = await handleAdminRequest(
		new Request("https://paab.test/admin/agents", {
			method: "GET",
			headers: { "Cf-Access-Jwt-Assertion": jwt },
		}),
		accessEnv(),
		now,
		{ fetchJwks: fetcher },
	);
	const jar = new TestCookieJar();
	jar.applyResponse(response);
	const html = await response.text();
	const csrfToken = extractCsrfToken(html);
	return {
		session: { jar, cookie: jar.header(), csrfToken, jwt, fetcher },
		response,
		html,
	};
}

async function adminGet(
	session: AdminSession,
	path: string,
	now = T0,
): Promise<{ response: Response; html: string }> {
	const response = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "GET",
			headers: {
				Cookie: session.jar.header(),
				"Cf-Access-Jwt-Assertion": session.jwt,
			},
		}),
		accessEnv(),
		now,
		{ fetchJwks: session.fetcher },
	);
	session.jar.applyResponse(response);
	syncSession(session);
	return { response, html: await response.text() };
}

async function adminPost(
	session: AdminSession,
	path: string,
	fields: Record<string, string>,
	now = T0,
): Promise<{
	response: Response;
	postResponse: Response;
	location: string | null;
	html: string;
}> {
	const body = new URLSearchParams({
		csrf_token: session.csrfToken,
		...fields,
	});
	const postResponse = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "POST",
			headers: {
				Cookie: session.jar.header(),
				Origin: "https://paab.test",
				"Cf-Access-Jwt-Assertion": session.jwt,
			},
			body,
		}),
		accessEnv(),
		now,
		{ fetchJwks: session.fetcher },
	);
	session.jar.applyResponse(postResponse);
	syncSession(session);
	if (postResponse.status === 303) {
		const location = postResponse.headers.get("Location");
		if (location === null) {
			throw new Error("Expected Location header on 303 response");
		}
		const followed = await adminGet(session, location, now);
		return {
			response: followed.response,
			postResponse,
			location,
			html: followed.html,
		};
	}
	return {
		response: postResponse,
		postResponse,
		location: null,
		html: await postResponse.text(),
	};
}

async function mcpRawPost(token: string, now = T0): Promise<Response> {
	return handleMcpRequest(
		new Request(MCP_URL, {
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
					clientInfo: { name: "test", version: "0.0.0" },
				},
			}),
		}),
		accessEnv(),
		now,
	);
}

function extractIssuedToken(htmlText: string): string {
	const match = /<div class="token-box">(paab_[A-Za-z0-9_-]+)<\/div>/.exec(
		htmlText,
	);
	if (!match?.[1]) {
		throw new Error("Could not find issued token in token-box");
	}
	return match[1];
}

async function findAgentIdByName(name: string): Promise<string> {
	const row = await db
		.prepare("SELECT id FROM agents WHERE name = ?")
		.bind(name)
		.first<{ id: string }>();
	if (!row) {
		throw new Error(`Agent not found: ${name}`);
	}
	return row.id;
}

async function assertNoTokenLeakInDb(token: string): Promise<void> {
	const tokenHash = await hashToken(token);
	const bodyOnly = token.slice("paab_".length);
	const [tokenRows, changeRows, auditRows] = await db.batch([
		db.prepare("SELECT * FROM tokens"),
		db.prepare("SELECT * FROM change_log"),
		db.prepare("SELECT * FROM audit_log"),
	]);
	const serializedDb = JSON.stringify([tokenRows.results, changeRows.results]);
	expect(serializedDb).not.toContain(token);
	expect(serializedDb).not.toContain(bodyOnly);
	expect(JSON.stringify(changeRows.results)).not.toContain(tokenHash);
	expect(JSON.stringify(auditRows.results)).not.toContain(token);
}

beforeAll(async () => {
	signingKey = await generateSigningKey("agents-ui-key");
});

beforeEach(async () => {
	db = await createTestDb();
});

describe("/admin/agents UI", () => {
	it("registers agents, issues participant tokens, serves /mcp, and never leaks plaintext tokens", async () => {
		const initial = await openAdminSession(ADMIN_EMAIL, T0);
		expect(initial.response.status).toBe(200);
		expect(initial.response.headers.get("Cache-Control")).toBe("no-store");
		expect(initial.html).toContain("エージェント管理（0件）");
		expect(initial.html).toContain('placeholder="me"');

		// Register muse with explicit owner_id and CRLF multi-line description.
		const regMuse = await adminPost(
			initial.session,
			"/admin/agents",
			{
				name: "muse",
				description: "予定と連絡先\r\nを管理",
				daily_question_limit: "15",
				owner_id: "owner-custom",
			},
			T0 + 10,
		);
		expect(regMuse.postResponse.status).toBe(303);
		expect(regMuse.location).toBe("/admin/agents");
		expect(findSetCookie(regMuse.postResponse, FLASH_COOKIE_NAME)).toContain(
			"HttpOnly",
		);
		expect(regMuse.response.status).toBe(200);
		expect(findSetCookie(regMuse.response, FLASH_COOKIE_NAME)).toContain(
			"Max-Age=0",
		);
		expect(regMuse.html).toContain("エージェント「muse」を登録しました");
		expect(regMuse.html).toContain("所有者: owner-custom");
		expect(regMuse.html).toContain("未発行");

		// Register grok omitting owner_id so it defaults to resolveDefaultOwnerId (owner-custom).
		const regGrok = await adminPost(
			initial.session,
			"/admin/agents",
			{
				name: "grok",
				description: "調べもの担当",
				daily_question_limit: "20",
				owner_id: "",
			},
			T0 + 20,
		);
		expect(regGrok.postResponse.status).toBe(303);
		expect(regGrok.location).toBe("/admin/agents");
		expect(regGrok.response.status).toBe(200);
		expect(regGrok.html).toContain("エージェント「grok」を登録しました");
		expect(regGrok.html).toContain('placeholder="owner-custom"');

		const museId = await findAgentIdByName("muse");
		const grokId = await findAgentIdByName("grok");

		// Issue participant tokens for both via UI.
		const csrfBeforeMuseIssue = initial.session.csrfToken;
		const issueMuse = await adminPost(
			initial.session,
			`/admin/agents/${museId}/token`,
			{},
			T0 + 30,
		);
		expect(issueMuse.response.status).toBe(200);
		expect(issueMuse.response.headers.get("Cache-Control")).toBe("no-store");
		const rotatedCookie = findSetCookie(
			issueMuse.response,
			csrfCookieName(ADMIN_ORIGIN),
		);
		expect(rotatedCookie).toBeTruthy();
		expect(initial.session.csrfToken).not.toBe(csrfBeforeMuseIssue);
		expect(issueMuse.response.headers.get("Location")).toBeNull();
		expect(issueMuse.html).toContain("今この画面に一度だけ表示されます");
		expect(issueMuse.html).toContain("Authorization: Bearer");
		expect(issueMuse.html).toContain("https://paab.test/mcp");
		// Ensure no extra inline <script> tag was introduced beyond the layout timestamp script.
		expect(issueMuse.html.match(/<script>/g)).toHaveLength(1);

		const museToken = extractIssuedToken(issueMuse.html);
		expect(rotatedCookie).not.toContain(museToken);
		expect(rotatedCookie).not.toContain(museToken.slice("paab_".length));
		await assertNoTokenLeakInDb(museToken);

		const issueGrok = await adminPost(
			initial.session,
			`/admin/agents/${grokId}/token`,
			{},
			T0 + 40,
		);
		expect(issueGrok.response.status).toBe(200);
		const grokToken = extractIssuedToken(issueGrok.html);
		await assertNoTokenLeakInDb(grokToken);

		// Subsequent GET /admin/agents shows active token metadata + warning before reissue, NEVER plaintext.
		const listAfterIssue = await adminGet(
			initial.session,
			"/admin/agents",
			T0 + 50,
		);
		expect(listAfterIssue.response.status).toBe(200);
		expect(listAfterIssue.html).not.toContain(museToken);
		expect(listAfterIssue.html).not.toContain(grokToken);
		expect(listAfterIssue.html).toContain("参加者トークンを再発行");
		expect(listAfterIssue.html).toContain(
			"現在有効なトークンは即座に無効になります",
		);
		expect(listAfterIssue.html).toContain(
			`<time datetime="${new Date(T0 + 30).toISOString()}">`,
		);

		// Verify real MCP round trip through /mcp using UI-issued tokens.
		const schedule = await seedCategory(db, { name: "予定" });
		await grantAllowRule(db, {
			fromAgentId: museId,
			toAgentId: grokId,
			categoryId: schedule.id,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 55,
		});

		const museClient = await connect(museToken, {
			env: accessEnv(),
			now: T0 + 60,
		});
		const agentsRes = await call(museClient, "list_agents");
		expect(agentsRes.text).toContain("name: grok");
		expect(agentsRes.text).toContain("調べもの担当");

		const askRes = await call(museClient, "ask", {
			to: "grok",
			category: "予定",
			question: "明日の予定は？",
		});
		expect(askRes.isError).toBe(false);

		const grokClient = await connect(grokToken, {
			env: accessEnv(),
			now: T0 + 61,
		});
		const inboxRes = await call(grokClient, "check_inbox");
		expect(inboxRes.text).toContain("明日の予定は？");

		// Today's UTC question count should now show 1 for muse and 0 for grok.
		const afterAsk = await adminGet(initial.session, "/admin/agents", T0 + 62);
		expect(afterAsk.html).toContain("本日の質問数 (UTC): <strong>1</strong>");
	});

	it("immediately invalidates old tokens on reissue and revoke", async () => {
		const { session } = await openAdminSession(ADMIN_EMAIL, T0);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "a", daily_question_limit: "10" },
			T0 + 1,
		);
		const museId = await findAgentIdByName("muse");

		const firstIssue = await adminPost(
			session,
			`/admin/agents/${museId}/token`,
			{},
			T0 + 2,
		);
		const token1 = extractIssuedToken(firstIssue.html);
		expect((await mcpRawPost(token1, T0 + 3)).status).toBe(200);

		// Reissue invalidates token1 immediately.
		const reissue = await adminPost(
			session,
			`/admin/agents/${museId}/token`,
			{},
			T0 + 4,
		);
		expect(reissue.response.status).toBe(200);
		expect(reissue.response.headers.get("Cache-Control")).toBe("no-store");
		expect(reissue.html).toContain(
			"以前の参加者トークンは即座に無効になりました",
		);
		const token2 = extractIssuedToken(reissue.html);
		expect(token2).not.toBe(token1);

		expect((await mcpRawPost(token1, T0 + 5)).status).toBe(401);
		expect((await mcpRawPost(token2, T0 + 5)).status).toBe(200);
		await expect(
			connect(token1, { env: accessEnv(), now: T0 + 5 }),
		).rejects.toThrow();

		const afterReissue = await adminGet(session, "/admin/agents", T0 + 6);
		expect(afterReissue.html).not.toContain(token1);
		expect(afterReissue.html).not.toContain(token2);
		await assertNoTokenLeakInDb(token1);
		await assertNoTokenLeakInDb(token2);

		// Revoke invalidates token2 immediately.
		const revoke = await adminPost(
			session,
			`/admin/agents/${museId}/token/revoke`,
			{},
			T0 + 7,
		);
		expect(revoke.response.status).toBe(200);
		expect(revoke.html).toContain("参加者トークンを失効させました");
		expect(revoke.html).toContain("未発行");
		expect((await mcpRawPost(token2, T0 + 8)).status).toBe(401);

		// Repeating revoke with no active token succeeds cleanly without adding a change_log row.
		const logsBefore = await queryChangeLog(db);
		const revokeAgain = await adminPost(
			session,
			`/admin/agents/${museId}/token/revoke`,
			{},
			T0 + 9,
		);
		expect(revokeAgain.response.status).toBe(200);
		expect(revokeAgain.html).toContain(
			"有効な参加者トークンはありませんでした",
		);
		expect(await queryChangeLog(db)).toHaveLength(logsBefore.length);
	});

	it("blocks /mcp with 403 when suspended, restores access on resume, and handles 2-step deletion", async () => {
		const { session } = await openAdminSession(ADMIN_EMAIL, T0);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "original", daily_question_limit: "5" },
			T0 + 1,
		);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "grok", description: "peer", daily_question_limit: "5" },
			T0 + 2,
		);
		const museId = await findAgentIdByName("muse");
		const grokId = await findAgentIdByName("grok");
		const work = await seedCategory(db, { name: "仕事" });
		await grantAllowRule(db, {
			fromAgentId: museId,
			toAgentId: grokId,
			categoryId: work.id,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 3,
		});

		const issued = await adminPost(
			session,
			`/admin/agents/${museId}/token`,
			{},
			T0 + 4,
		);
		const museToken = extractIssuedToken(issued.html);

		// Edit description and daily_question_limit via UI.
		const edited = await adminPost(
			session,
			`/admin/agents/${museId}/update`,
			{ description: "updated\r\ndesc", daily_question_limit: "12" },
			T0 + 5,
		);
		expect(edited.response.status).toBe(200);
		expect(edited.html).toContain("更新しました");
		expect(edited.html).toContain("updated\ndesc");
		expect(edited.html).toContain("1日上限 <strong>12</strong>");

		// Suspend from UI -> /mcp returns 403.
		const suspended = await adminPost(
			session,
			`/admin/agents/${museId}/suspend`,
			{},
			T0 + 6,
		);
		expect(suspended.response.status).toBe(200);
		expect(suspended.html).toContain("停止しました");
		expect(suspended.html).toContain("停止中");

		const mcpSuspended = await mcpRawPost(museToken, T0 + 7);
		expect(mcpSuspended.status).toBe(403);
		await expect(
			connect(museToken, { env: accessEnv(), now: T0 + 7 }),
		).rejects.toThrow();

		// Resume from UI -> /mcp access restored with same token.
		const resumed = await adminPost(
			session,
			`/admin/agents/${museId}/resume`,
			{},
			T0 + 8,
		);
		expect(resumed.response.status).toBe(200);
		expect(resumed.html).toContain("再開しました");
		expect(resumed.html).toContain("有効");

		const mcpResumed = await connect(museToken, {
			env: accessEnv(),
			now: T0 + 9,
		});
		expect((await call(mcpResumed, "list_agents")).text).toContain(
			"name: grok",
		);

		// Step 1 of delete: GET confirmation page does not delete the agent.
		const confirm = await adminGet(
			session,
			`/admin/agents/${museId}/delete`,
			T0 + 10,
		);
		expect(confirm.response.status).toBe(200);
		expect(confirm.html).toContain("エージェントの削除確認");
		expect(confirm.html).toContain("muse");
		expect(confirm.html).toContain(`/admin/agents/${museId}/delete`);
		expect((await mcpRawPost(museToken, T0 + 11)).status).toBe(200);

		// Step 2 of delete: POST executes deletion, cascades allow rules/tokens, rejects /mcp with 401.
		const deleted = await adminPost(
			session,
			`/admin/agents/${museId}/delete`,
			{},
			T0 + 12,
		);
		expect(deleted.response.status).toBe(200);
		expect(deleted.html).toContain("エージェント「muse」を削除しました");
		expect(deleted.html).toContain("許可ルール 1件も削除しました");
		expect((await mcpRawPost(museToken, T0 + 13)).status).toBe(401);

		const remainingRules = await db
			.prepare("SELECT COUNT(*) AS n FROM allow_rules")
			.first<{ n: number }>();
		expect(remainingRules?.n).toBe(0);

		// Every mutation recorded change_log with the Access user email as actor_id.
		const logs = await queryChangeLog(db);
		expect(logs.map((entry) => entry.action)).toEqual([
			"agent_deleted",
			"agent_resumed",
			"agent_suspended",
			"agent_updated",
			"token_issued",
			"allow_rule_granted",
			"agent_registered",
			"agent_registered",
		]);
		for (const entry of logs) {
			expect(entry.actorType).toBe("owner");
			expect(entry.actorId).toBe(ADMIN_EMAIL);
		}
	});

	it("validates integer limits strictly, escapes errors, and handles missing agents cleanly", async () => {
		const { session } = await openAdminSession(ADMIN_EMAIL, T0);

		for (const badLimit of ["", "   ", "-1", "1.5", "10abc", "1e2", "0x10"]) {
			const res = await adminPost(
				session,
				"/admin/agents",
				{
					name: "<script>xss</script>",
					description: "desc",
					daily_question_limit: badLimit,
				},
				T0 + 1,
			);
			expect(res.postResponse.status).toBe(303);
			expect(res.location).toBe("/admin/agents");
			expect(res.response.status).toBe(200);
			expect(res.html).toContain('class="banner banner-error"');
			expect(res.html).toContain(
				"1日あたりの質問数上限は0以上の整数で入力してください",
			);
			expect(res.html).not.toContain("<script>xss</script>");
		}

		// Registering an agent with HTML special chars escapes both the flash banner and agent card.
		const xssReg = await adminPost(
			session,
			"/admin/agents",
			{
				name: "<script>xss</script>",
				description: "ok",
				daily_question_limit: "5",
			},
			T0 + 1,
		);
		expect(xssReg.postResponse.status).toBe(303);
		expect(xssReg.html).toContain("&lt;script&gt;xss&lt;/script&gt;");
		expect(xssReg.html).not.toContain("<script>xss</script>");

		// Duplicate and invalid names are rejected cleanly via 303 + error flash.
		await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "ok", daily_question_limit: "5" },
			T0 + 2,
		);
		const dup = await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "dup", daily_question_limit: "5" },
			T0 + 3,
		);
		expect(dup.postResponse.status).toBe(303);
		expect(dup.html).toContain('class="banner banner-error"');
		expect(dup.html).toContain("すでに登録されています");

		const badName = await adminPost(
			session,
			"/admin/agents",
			{ name: "bad,name", description: "ok", daily_question_limit: "5" },
			T0 + 4,
		);
		expect(badName.postResponse.status).toBe(303);
		expect(badName.html).toContain('class="banner banner-error"');
		expect(badName.html).toContain("改行・制御文字・カンマ");

		// Invalid integer on edit leaves DB untouched.
		const museId = await findAgentIdByName("muse");
		const badEdit = await adminPost(
			session,
			`/admin/agents/${museId}/update`,
			{ description: "changed", daily_question_limit: "12px" },
			T0 + 5,
		);
		expect(badEdit.postResponse.status).toBe(303);
		expect(badEdit.html).toContain('class="banner banner-error"');
		expect(badEdit.html).toContain(
			"1日あたりの質問数上限は0以上の整数で入力してください",
		);
		const row = await db
			.prepare(
				"SELECT daily_question_limit, description FROM agents WHERE id = ?",
			)
			.bind(museId)
			.first<{ daily_question_limit: number; description: string }>();
		expect(row).toEqual({ daily_question_limit: 5, description: "ok" });

		// Missing agent returns 404 on GET confirmation and 303 + error flash across POST endpoints.
		const missingId = newId();
		expect(
			(await adminGet(session, `/admin/agents/${missingId}/delete`, T0 + 6))
				.response.status,
		).toBe(404);
		for (const [path, fields] of [
			[
				`/admin/agents/${missingId}/update`,
				{ description: "x", daily_question_limit: "1" },
			],
			[`/admin/agents/${missingId}/suspend`, {}],
			[`/admin/agents/${missingId}/resume`, {}],
			[`/admin/agents/${missingId}/delete`, {}],
			[`/admin/agents/${missingId}/token`, {}],
			[`/admin/agents/${missingId}/token/revoke`, {}],
		] as const) {
			const res = await adminPost(session, path, fields, T0 + 6);
			expect(res.postResponse.status, path).toBe(303);
			expect(res.location, path).toBe("/admin/agents");
			expect(res.html, path).toContain('class="banner banner-error"');
			expect(res.html, path).toContain("見つかりません");
		}
	});

	it("counts only today's UTC questions in the agent list and enforces CSRF", async () => {
		const { session } = await openAdminSession(ADMIN_EMAIL, T0);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "", daily_question_limit: "5" },
			T0,
		);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "grok", description: "", daily_question_limit: "5" },
			T0,
		);
		const museId = await findAgentIdByName("muse");
		const grokId = await findAgentIdByName("grok");
		const cat = await seedCategory(db, { name: "仕事" });

		await db.batch([
			insertMessage(db, {
				id: newId(),
				kind: "question",
				fromAgentId: museId,
				toAgentId: grokId,
				categoryId: cat.id,
				body: "yesterday",
				inReplyTo: null,
				status: "pending",
				createdAt: T0 - 1,
				receivedAt: null,
				expiresAt: T0 + 7 * DAY_MS,
				bodyDeletedAt: null,
			}),
			insertMessage(db, {
				id: newId(),
				kind: "question",
				fromAgentId: museId,
				toAgentId: grokId,
				categoryId: cat.id,
				body: "today",
				inReplyTo: null,
				status: "pending",
				createdAt: T0 + HOUR_MS,
				receivedAt: null,
				expiresAt: T0 + 7 * DAY_MS,
				bodyDeletedAt: null,
			}),
		]);

		const page = await adminGet(session, "/admin/agents", T0 + 2 * HOUR_MS);
		expect(page.html).toContain("本日の質問数 (UTC): <strong>1</strong>");

		// Missing CSRF token is rejected with 403.
		const noCsrf = await handleAdminRequest(
			new Request("https://paab.test/admin/agents", {
				method: "POST",
				headers: {
					Cookie: session.cookie,
					Origin: "https://paab.test",
					"Cf-Access-Jwt-Assertion": session.jwt,
				},
				body: new URLSearchParams({
					name: "rogue",
					daily_question_limit: "1",
				}),
			}),
			accessEnv(),
			T0 + 2 * HOUR_MS,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrf.status).toBe(403);
	});
});
