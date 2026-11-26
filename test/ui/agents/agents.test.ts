import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configureAgentWebhook,
	deleteAgentWebhook,
	grantAllowRule,
	issueAgentToken,
	queryChangeLog,
} from "../../../src/admin";
import {
	createProposal,
	designateAdminBot,
	issueAdminBotToken,
} from "../../../src/adminbot";
import { authenticate, hashToken } from "../../../src/auth";
import { insertMessage, newId } from "../../../src/db";
import { handleMcpRequest } from "../../../src/mcp";
import {
	signWebhookPayload,
	WEBHOOK_BODY,
	type WebhookFetcher,
} from "../../../src/notify";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { handleUnreadRequest } from "../../../src/unread";
import { createTestDb } from "../../helpers/db";
import { DAY_MS, HOUR_MS, seedCategory, T0 } from "../../helpers/fixtures";
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

interface AdminSession {
	cookie: string;
	csrfToken: string;
	jwt: string;
	fetcher: JwksFetcher;
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
	const setCookie = response.headers.get("Set-Cookie") ?? "";
	const cookie = setCookie.split(";", 1)[0] ?? "";
	const html = await response.text();
	const csrfToken = extractCsrfToken(html);
	return {
		session: { cookie, csrfToken, jwt, fetcher },
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
				Cookie: session.cookie,
				"Cf-Access-Jwt-Assertion": session.jwt,
			},
		}),
		accessEnv(),
		now,
		{ fetchJwks: session.fetcher },
	);
	return { response, html: await response.text() };
}

async function adminPost(
	session: AdminSession,
	path: string,
	fields: Record<string, string>,
	now = T0,
): Promise<{ response: Response; html: string }> {
	const body = new URLSearchParams({
		csrf_token: session.csrfToken,
		...fields,
	});
	const response = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "POST",
			headers: {
				Cookie: session.cookie,
				Origin: "https://paab.test",
				"Cf-Access-Jwt-Assertion": session.jwt,
			},
			body,
		}),
		accessEnv(),
		now,
		{ fetchJwks: session.fetcher },
	);
	return { response, html: await response.text() };
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
		expect(regMuse.response.status).toBe(200);
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
		expect(regGrok.response.status).toBe(200);
		expect(regGrok.html).toContain("エージェント「grok」を登録しました");
		expect(regGrok.html).toContain('placeholder="owner-custom"');

		const museId = await findAgentIdByName("muse");
		const grokId = await findAgentIdByName("grok");

		// Issue participant tokens for both via UI.
		const issueMuse = await adminPost(
			initial.session,
			`/admin/agents/${museId}/token`,
			{},
			T0 + 30,
		);
		expect(issueMuse.response.status).toBe(200);
		expect(issueMuse.response.headers.get("Cache-Control")).toBe("no-store");
		expect(issueMuse.response.headers.get("Set-Cookie")).toBeNull();
		expect(issueMuse.response.headers.get("Location")).toBeNull();
		expect(issueMuse.html).toContain("今この画面に一度だけ表示されます");
		expect(issueMuse.html).toContain("Authorization: Bearer");
		expect(issueMuse.html).toContain("https://paab.test/mcp");
		// Ensure no extra inline <script> tag was introduced beyond the layout timestamp script.
		expect(issueMuse.html.match(/<script>/g)).toHaveLength(1);

		const museToken = extractIssuedToken(issueMuse.html);
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
			expect(res.response.status).toBe(400);
			expect(res.html).toContain(
				"1日あたりの質問数上限は0以上の整数で入力してください",
			);
			expect(res.html).toContain("&lt;script&gt;xss&lt;/script&gt;");
			expect(res.html).not.toContain("<script>xss</script>");
		}

		// Duplicate and invalid names are rejected cleanly.
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
		expect(dup.response.status).toBe(400);
		expect(dup.html).toContain("すでに登録されています");

		const badName = await adminPost(
			session,
			"/admin/agents",
			{ name: "bad,name", description: "ok", daily_question_limit: "5" },
			T0 + 4,
		);
		expect(badName.response.status).toBe(400);
		expect(badName.html).toContain("改行・制御文字・カンマ");

		// Invalid integer on edit leaves DB untouched.
		const museId = await findAgentIdByName("muse");
		const badEdit = await adminPost(
			session,
			`/admin/agents/${museId}/update`,
			{ description: "changed", daily_question_limit: "12px" },
			T0 + 5,
		);
		expect(badEdit.response.status).toBe(400);
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

		// Missing agent returns 404 cleanly across endpoints.
		const missingId = newId();
		expect(
			(await adminGet(session, `/admin/agents/${missingId}/delete`, T0 + 6))
				.response.status,
		).toBe(404);
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingId}/update`,
					{ description: "x", daily_question_limit: "1" },
					T0 + 6,
				)
			).response.status,
		).toBe(404);
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingId}/suspend`,
					{},
					T0 + 6,
				)
			).response.status,
		).toBe(404);
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingId}/resume`,
					{},
					T0 + 6,
				)
			).response.status,
		).toBe(404);
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingId}/delete`,
					{},
					T0 + 6,
				)
			).response.status,
		).toBe(404);
		expect(
			(await adminPost(session, `/admin/agents/${missingId}/token`, {}, T0 + 6))
				.response.status,
		).toBe(404);
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingId}/token/revoke`,
					{},
					T0 + 6,
				)
			).response.status,
		).toBe(404);
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

	it("manages unread_count tokens separately from participant and admin tokens", async () => {
		const { session } = await openAdminSession(ADMIN_EMAIL, T0);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "a", daily_question_limit: "5" },
			T0 + 1,
		);
		const museId = await findAgentIdByName("muse");

		// Issue participant and admin tokens alongside unread_count to verify isolation.
		const partIssue = await adminPost(
			session,
			`/admin/agents/${museId}/token`,
			{},
			T0 + 2,
		);
		const partToken = extractIssuedToken(partIssue.html);
		const adminIssued = await issueAgentToken(db, {
			agentId: museId,
			purpose: "admin",
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 3,
		});
		expect(adminIssued.ok).toBe(true);
		if (!adminIssued.ok) return;

		// Before issuing unread_count, the card shows participant as valid and unread_count as not issued.
		const beforeUnread = await adminGet(session, "/admin/agents", T0 + 4);
		expect(beforeUnread.html).toContain("参加者トークン:");
		expect(beforeUnread.html).toContain("件数確認トークン（/unread）:");
		expect(beforeUnread.html).toContain("件数確認トークンを発行");
		expect(beforeUnread.html).toContain("未発行");

		// Issue unread_count token via UI.
		const issueUnread = await adminPost(
			session,
			`/admin/agents/${museId}/unread-token`,
			{},
			T0 + 5,
		);
		expect(issueUnread.response.status).toBe(200);
		expect(issueUnread.response.headers.get("Cache-Control")).toBe("no-store");
		expect(issueUnread.html).toContain("件数確認トークンを発行しました");
		expect(issueUnread.html).toContain("今この画面に一度だけ表示されます");
		expect(issueUnread.html).toContain("https://paab.test/unread");
		expect(issueUnread.html).toContain("VM 上の定期確認スクリプト");
		expect(issueUnread.html).toContain("質問・回答の本文は取得できません");
		expect(issueUnread.html.match(/<script>/g)).toHaveLength(1);

		const unreadToken1 = extractIssuedToken(issueUnread.html);
		expect(unreadToken1).not.toBe(partToken);
		await assertNoTokenLeakInDb(unreadToken1);

		// Verify unread_count token works on /unread, fails on /mcp, and participant/admin tokens stay valid.
		const unreadOk = await handleUnreadRequest(
			new Request("https://paab.test/unread", {
				headers: { Authorization: `Bearer ${unreadToken1}` },
			}),
			accessEnv(),
			T0 + 6,
		);
		expect(unreadOk.status).toBe(200);
		expect(await unreadOk.json()).toEqual({ unread: 0 });
		expect((await mcpRawPost(unreadToken1, T0 + 6)).status).toBe(401);
		expect((await mcpRawPost(partToken, T0 + 6)).status).toBe(200);
		expect(
			await authenticate(db, `Bearer ${adminIssued.data.token}`, "admin"),
		).toMatchObject({ ok: true, agent: { id: museId } });

		// GET /admin/agents shows unread_count token timestamp without ever exposing plaintext.
		const listAfterIssue = await adminGet(session, "/admin/agents", T0 + 7);
		expect(listAfterIssue.html).not.toContain(unreadToken1);
		expect(listAfterIssue.html).not.toContain(partToken);
		expect(listAfterIssue.html).toContain("件数確認トークンを再発行");
		expect(listAfterIssue.html).toContain(
			`<time datetime="${new Date(T0 + 5).toISOString()}">`,
		);

		// Delete confirmation page reflects both active tokens.
		const confirmDelete = await adminGet(
			session,
			`/admin/agents/${museId}/delete`,
			T0 + 8,
		);
		expect(confirmDelete.html).toContain("件数確認トークン（/unread）:");
		expect(confirmDelete.html).toContain(
			"有効なトークンあり（同時に削除されます）",
		);

		// Reissue unread_count atomically revokes unreadToken1 while keeping participant & admin active.
		const reissueUnread = await adminPost(
			session,
			`/admin/agents/${museId}/unread-token`,
			{},
			T0 + 9,
		);
		expect(reissueUnread.response.status).toBe(200);
		expect(reissueUnread.response.headers.get("Cache-Control")).toBe(
			"no-store",
		);
		expect(reissueUnread.html).toContain(
			"以前の件数確認トークンは即座に無効になりました",
		);
		const unreadToken2 = extractIssuedToken(reissueUnread.html);
		expect(unreadToken2).not.toBe(unreadToken1);
		await assertNoTokenLeakInDb(unreadToken2);

		expect(
			(
				await handleUnreadRequest(
					new Request("https://paab.test/unread", {
						headers: { Authorization: `Bearer ${unreadToken1}` },
					}),
					accessEnv(),
					T0 + 10,
				)
			).status,
		).toBe(401);
		expect(
			(
				await handleUnreadRequest(
					new Request("https://paab.test/unread", {
						headers: { Authorization: `Bearer ${unreadToken2}` },
					}),
					accessEnv(),
					T0 + 10,
				)
			).status,
		).toBe(200);
		expect((await mcpRawPost(partToken, T0 + 10)).status).toBe(200);
		expect(
			await authenticate(db, `Bearer ${adminIssued.data.token}`, "admin"),
		).toMatchObject({ ok: true, agent: { id: museId } });

		// Revoke unread_count invalidates unreadToken2 only.
		const revokeUnread = await adminPost(
			session,
			`/admin/agents/${museId}/unread-token/revoke`,
			{},
			T0 + 11,
		);
		expect(revokeUnread.response.status).toBe(200);
		expect(revokeUnread.html).toContain("件数確認トークンを失効させました");
		expect(revokeUnread.html).toContain("件数確認トークンを発行");
		expect(revokeUnread.html).toContain("参加者トークンを再発行");

		expect(
			(
				await handleUnreadRequest(
					new Request("https://paab.test/unread", {
						headers: { Authorization: `Bearer ${unreadToken2}` },
					}),
					accessEnv(),
					T0 + 12,
				)
			).status,
		).toBe(401);
		expect((await mcpRawPost(partToken, T0 + 12)).status).toBe(200);
		expect(
			await authenticate(db, `Bearer ${adminIssued.data.token}`, "admin"),
		).toMatchObject({ ok: true, agent: { id: museId } });

		// Repeating revoke writes no extra change_log entry.
		const logsBefore = await queryChangeLog(db);
		const revokeAgain = await adminPost(
			session,
			`/admin/agents/${museId}/unread-token/revoke`,
			{},
			T0 + 13,
		);
		expect(revokeAgain.response.status).toBe(200);
		expect(revokeAgain.html).toContain(
			"有効な件数確認トークンはありませんでした",
		);
		expect(await queryChangeLog(db)).toHaveLength(logsBefore.length);

		// Missing agent ID returns 404 for unread-token routes too.
		const missingId = newId();
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingId}/unread-token`,
					{},
					T0 + 14,
				)
			).response.status,
		).toBe(404);
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingId}/unread-token/revoke`,
					{},
					T0 + 14,
				)
			).response.status,
		).toBe(404);

		// Change log contains token_issued and token_revoked for unread_count with owner email actor.
		const logs = await queryChangeLog(db);
		expect(logs.slice(0, 3).map((l) => l.action)).toEqual([
			"token_revoked",
			"token_issued",
			"token_issued",
		]);
		for (const entry of logs.slice(0, 3)) {
			expect(entry.actorType).toBe("owner");
			expect(entry.actorId).toBe(ADMIN_EMAIL);
			const meta = JSON.parse(entry.afterJson ?? entry.beforeJson ?? "null");
			if (entry.action === "token_issued") {
				expect(meta.purpose).toBe("unread_count");
			} else {
				expect(meta.tokens[0].purpose).toBe("unread_count");
			}
		}
	});

	it("configures, rotates, and deletes agent webhooks in the human UI only without leaking signing_secret", async () => {
		const { session } = await openAdminSession(ADMIN_EMAIL, T0);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "a", daily_question_limit: "10" },
			T0 + 1,
		);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "grok", description: "b", daily_question_limit: "10" },
			T0 + 2,
		);
		const museId = await findAgentIdByName("muse");
		const grokId = await findAgentIdByName("grok");

		// Invalid/SSRF URLs are rejected with 400 and leave DB and change_log clean.
		for (const badUrl of [
			"http://agent.example/wake",
			"https://localhost/wake",
			"https://127.0.0.1/wake",
			"https://169.254.169.254/latest",
			"https://user:pass@agent.example/wake",
		]) {
			const invalid = await adminPost(
				session,
				`/admin/agents/${museId}/webhook`,
				{ url: badUrl },
				T0 + 3,
			);
			expect(invalid.response.status).toBe(400);
		}
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM agent_webhooks")
				.first<{ n: number }>(),
		).toEqual({ n: 0 });

		// Valid HTTPS URL returns one-time signing_secret with Cache-Control: no-store and no extra <script>.
		const configured = await adminPost(
			session,
			`/admin/agents/${grokId}/webhook`,
			{ url: "https://grok.example/wake" },
			T0 + 10,
		);
		expect(configured.response.status).toBe(200);
		expect(configured.response.headers.get("Cache-Control")).toBe("no-store");
		expect(configured.html.match(/<script>/g)).toHaveLength(1);
		expect(configured.html).toContain("https://grok.example/wake");
		expect(configured.html).toContain("X-Paab-Signature");
		expect(configured.html).toContain("X-Paab-Timestamp");
		const secret1 = extractIssuedToken(configured.html);
		expect(secret1).toMatch(/^paab_whsec_[A-Za-z0-9_-]{43}$/);

		// Subsequent GET /admin/agents shows configured state, URL, timestamp, and NEVER exposes signing_secret.
		const afterConfigGet = await adminGet(session, "/admin/agents", T0 + 11);
		expect(afterConfigGet.response.status).toBe(200);
		expect(afterConfigGet.html).toContain("設定済み");
		expect(afterConfigGet.html).toContain("https://grok.example/wake");
		expect(afterConfigGet.html).not.toContain(secret1);

		// change_log stores { url } only, never signing_secret.
		const logsAfterConfig = await queryChangeLog(db);
		expect(logsAfterConfig[0]).toMatchObject({
			action: "webhook_configured",
			targetType: "agent",
			targetId: grokId,
			beforeJson: null,
			afterJson: JSON.stringify({ url: "https://grok.example/wake" }),
		});
		expect(JSON.stringify(logsAfterConfig)).not.toContain(secret1);

		// /admin/rules change_log table renders Webhook設定 cleanly without leaking secret.
		const rulesView = await adminGet(session, "/admin/rules", T0 + 12);
		expect(rulesView.html).toContain("Webhook設定");
		expect(rulesView.html).toContain("URL=https://grok.example/wake");
		expect(rulesView.html).not.toContain(secret1);

		// Update URL & rotate signing_secret.
		const rotated = await adminPost(
			session,
			`/admin/agents/${grokId}/webhook`,
			{ url: "https://grok-v2.example/wake" },
			T0 + 20,
		);
		expect(rotated.response.status).toBe(200);
		expect(rotated.response.headers.get("Cache-Control")).toBe("no-store");
		expect(rotated.html).toContain("以前の署名鍵は即座に無効になりました");
		const secret2 = extractIssuedToken(rotated.html);
		expect(secret2).toMatch(/^paab_whsec_[A-Za-z0-9_-]{43}$/);
		expect(secret2).not.toBe(secret1);

		// End-to-end: UI-configured webhook fires with secret2 when muse asks grok over /mcp.
		const cat = await seedCategory(db, { name: "予定" });
		await grantAllowRule(db, {
			fromAgentId: museId,
			toAgentId: grokId,
			categoryId: cat.id,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 21,
		});
		const museIssue = await adminPost(
			session,
			`/admin/agents/${museId}/token`,
			{},
			T0 + 22,
		);
		const museToken = extractIssuedToken(museIssue.html);
		const captured: {
			url: string;
			ts: string | null;
			sig: string | null;
			body: string;
		}[] = [];
		const webhookFetcher: WebhookFetcher = async (input, init) => {
			const h = new Headers(init?.headers);
			captured.push({
				url: String(input),
				ts: h.get("X-Paab-Timestamp"),
				sig: h.get("X-Paab-Signature"),
				body: String(init?.body ?? ""),
			});
			return new Response("ok", { status: 200 });
		};
		const museClient = await connect(museToken, {
			env: { ...accessEnv(), webhookFetcher },
			now: T0 + 25,
		});
		await call(museClient, "ask", {
			to: "grok",
			category: "予定",
			question: "確認です",
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://grok-v2.example/wake");
		expect(captured[0]?.body).toBe(WEBHOOK_BODY);
		expect(captured[0]?.sig).toBe(
			await signWebhookPayload(secret2, captured[0]?.ts ?? "", WEBHOOK_BODY),
		);

		// Delete webhook via UI.
		const deleted = await adminPost(
			session,
			`/admin/agents/${grokId}/webhook/delete`,
			{},
			T0 + 30,
		);
		expect(deleted.response.status).toBe(200);
		expect(deleted.html).toContain("Webhook を削除しました");
		expect(deleted.html).not.toContain(secret2);

		// Repeating delete is a clean no-op without adding a change_log row.
		const logsBeforeRepeat = await queryChangeLog(db);
		const deletedAgain = await adminPost(
			session,
			`/admin/agents/${grokId}/webhook/delete`,
			{},
			T0 + 31,
		);
		expect(deletedAgain.response.status).toBe(200);
		expect(deletedAgain.html).toContain("Webhook は設定されていませんでした");
		expect(await queryChangeLog(db)).toHaveLength(logsBeforeRepeat.length);

		// Missing agent returns 404; missing CSRF returns 403.
		const missingWebhookId = newId();
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingWebhookId}/webhook`,
					{ url: "https://ok.example/wake" },
					T0 + 32,
				)
			).response.status,
		).toBe(404);
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingWebhookId}/webhook/delete`,
					{},
					T0 + 32,
				)
			).response.status,
		).toBe(404);
		const noCsrfWebhook = await handleAdminRequest(
			new Request(`https://paab.test/admin/agents/${grokId}/webhook`, {
				method: "POST",
				headers: {
					Cookie: session.cookie,
					Origin: "https://paab.test",
					"Cf-Access-Jwt-Assertion": session.jwt,
				},
				body: new URLSearchParams({ url: "https://ok.example/wake" }),
			}),
			accessEnv(),
			T0 + 33,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrfWebhook.status).toBe(403);

		// Admin bot cannot call configureAgentWebhook or deleteAgentWebhook, and neither /mcp nor /mcp/admin exposes webhook tools.
		expect(
			await configureAgentWebhook(db, {
				agentId: grokId,
				url: "https://ok.example/wake",
				actor: { actorType: "admin_bot", actorId: museId },
				now: T0 + 34,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });
		expect(
			await deleteAgentWebhook(db, {
				agentId: grokId,
				actor: { actorType: "admin_bot", actorId: museId },
				now: T0 + 34,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });

		const participantTools = (await museClient.listTools()).tools.map(
			(t) => t.name,
		);
		for (const name of participantTools) {
			expect(name).not.toMatch(/webhook|secret/i);
		}
		await designateAdminBot(db, {
			agentId: museId,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 35,
		});
		const adminTok = await issueAdminBotToken(db, {
			agentId: museId,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 36,
		});
		expect(adminTok.ok).toBe(true);
		if (!adminTok.ok) return;
		const adminTools = await listAdminMcpTools(adminTok.data.token, T0 + 37);
		expect(adminTools).toContain("view_audit_log");
		for (const name of adminTools) {
			expect(name).not.toMatch(/webhook|secret/i);
		}
	});

	it("shows full cascade impact on GET /admin/agents/:id/delete when admin bot, admin token, webhook, proposals, and pending description are present", async () => {
		const { session } = await openAdminSession(ADMIN_EMAIL, T0);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "original", daily_question_limit: "10" },
			T0 + 1,
		);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "grok", description: "plain", daily_question_limit: "10" },
			T0 + 2,
		);
		const museId = await findAgentIdByName("muse");
		const grokId = await findAgentIdByName("grok");

		// Plain agent without extra cascade targets shows baseline labels.
		const plainConfirm = await adminGet(
			session,
			`/admin/agents/${grokId}/delete`,
			T0 + 3,
		);
		expect(plainConfirm.response.status).toBe(200);
		expect(plainConfirm.html).toContain("指名されていません");
		expect(plainConfirm.html).toContain("<strong>Webhook 通知:</strong>");
		expect(plainConfirm.html).toContain("未設定");
		expect(plainConfirm.html).toContain(
			"<strong>管理者ボットの提案:</strong>\n\t\t\t\t\tなし",
		);
		expect(plainConfirm.html).toContain(
			"<strong>承認待ちの説明文:</strong>\n\t\t\t\t\tなし",
		);

		// Give muse: participant token + pending description + admin bot designation + admin token + webhook + proposal.
		const partIssue = await adminPost(
			session,
			`/admin/agents/${museId}/token`,
			{},
			T0 + 4,
		);
		const musePartToken = extractIssuedToken(partIssue.html);
		const museClient = await connect(musePartToken, {
			env: accessEnv(),
			now: T0 + 5,
		});
		const submitRes = await call(museClient, "submit_description", {
			description: "新しい説明文の案",
		});
		expect(submitRes.isError).toBe(false);

		const designated = await designateAdminBot(db, {
			agentId: museId,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 6,
		});
		expect(designated.ok).toBe(true);

		const adminTok = await issueAdminBotToken(db, {
			agentId: museId,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 7,
		});
		expect(adminTok.ok).toBe(true);

		const hook = await configureAgentWebhook(db, {
			agentId: museId,
			url: "https://muse.example/wake?a=1&b=2",
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 8,
		});
		expect(hook.ok).toBe(true);
		if (!hook.ok) return;

		const prop = await createProposal(db, {
			botAgentId: museId,
			request: { kind: "create_category", name: "旅" },
			reason: "旅行の相談用にカテゴリを追加したい",
			now: T0 + 9,
		});
		expect(prop.ok).toBe(true);

		// GET delete confirm renders every cascade impact cleanly and never leaks signing_secret or tokens.
		const confirm = await adminGet(
			session,
			`/admin/agents/${museId}/delete`,
			T0 + 10,
		);
		expect(confirm.response.status).toBe(200);
		expect(confirm.html).toContain("指名中");
		expect(confirm.html).toContain(
			"削除すると管理者ボットの指名が解除され、本文閲覧・最高管理者権限の設定もオフにリセットされます",
		);
		expect(confirm.html).toContain(
			"<strong>管理者トークン（/mcp/admin）:</strong>",
		);
		expect(confirm.html).toContain("有効なトークンあり（同時に削除されます）");
		expect(confirm.html).toContain("https://muse.example/wake?a=1&amp;b=2");
		expect(confirm.html).toContain("署名鍵と配信キューも同時に削除されます");
		expect(confirm.html).toContain(
			"1件（うち承認待ち 1件。同時に削除されます）",
		);
		expect(confirm.html).toContain(
			"<strong>承認待ちの説明文:</strong>\n\t\t\t\t\tあり（同時に削除されます）",
		);
		expect(confirm.html).not.toContain(hook.data.signingSecret);
		if (adminTok.ok) {
			expect(confirm.html).not.toContain(adminTok.data.token);
		}

		// Confirming deletion clears admin_bot_config and cascades proposals, pending_descriptions, webhooks, and tokens.
		const deleted = await adminPost(
			session,
			`/admin/agents/${museId}/delete`,
			{},
			T0 + 11,
		);
		expect(deleted.response.status).toBe(200);
		const [botCfg, proposalsLeft, descsLeft, hooksLeft, tokensLeft] =
			await db.batch([
				db.prepare("SELECT agent_id FROM admin_bot_config WHERE id = 1"),
				db
					.prepare("SELECT COUNT(*) AS n FROM proposals WHERE bot_agent_id = ?")
					.bind(museId),
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM pending_descriptions WHERE agent_id = ?",
					)
					.bind(museId),
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM agent_webhooks WHERE agent_id = ?",
					)
					.bind(museId),
				db
					.prepare("SELECT COUNT(*) AS n FROM tokens WHERE agent_id = ?")
					.bind(museId),
			]);
		expect(botCfg?.results[0]).toEqual({ agent_id: null });
		expect(proposalsLeft?.results[0]).toEqual({ n: 0 });
		expect(descsLeft?.results[0]).toEqual({ n: 0 });
		expect(hooksLeft?.results[0]).toEqual({ n: 0 });
		expect(tokensLeft?.results[0]).toEqual({ n: 0 });
	});
});

async function listAdminMcpTools(
	token: string,
	now: number,
): Promise<string[]> {
	const { Client, StreamableHTTPClientTransport } = await import(
		"@modelcontextprotocol/client"
	);
	const { handleAdminMcpRequest } = await import("../../../src/adminbot");
	const client = new Client({ name: "paab-admin-test", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(
		new URL("https://paab.test/mcp/admin"),
		{
			fetch: (input, init) =>
				handleAdminMcpRequest(new Request(input, init), accessEnv(), now),
			requestInit: {
				headers: { Authorization: `Bearer ${token}` },
			},
		},
	);
	await client.connect(transport);
	const { tools } = await client.listTools();
	return tools.map((tool) => tool.name);
}
