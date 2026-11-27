import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queryChangeLog } from "../../../src/admin";
import { hashToken } from "../../../src/auth";
import { newId } from "../../../src/db";
import { submitQuestion } from "../../../src/inbox";
import { handleMcpRequest } from "../../../src/mcp";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { handleUnreadRequest } from "../../../src/unread";
import { createTestDb } from "../../helpers/db";
import { seedCategory, T0 } from "../../helpers/fixtures";
import { MCP_URL } from "../../mcp/support";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "agents-unread-ui-aud";
const ADMIN_EMAIL = "owner-admin@example.com";
const UNREAD_URL = "https://paab.test/unread";

interface SigningKeyPair {
	kid: string;
	privateKey: CryptoKey;
	jwk: JwkKey;
}

interface AdminSession {
	cookie: string;
	csrfToken: string;
	jwt: string;
	fetcher: JwksFetcher;
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

function extractCsrfToken(htmlText: string): string {
	const match = /name="csrf_token" value="([^"]+)"/.exec(htmlText);
	if (!match?.[1]) {
		throw new Error("Could not find csrf_token in HTML response");
	}
	return match[1];
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

async function unreadRawGet(token: string, now = T0): Promise<Response> {
	return handleUnreadRequest(
		new Request(UNREAD_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		}),
		accessEnv(),
		now,
	);
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
	signingKey = await generateSigningKey("agents-unread-ui-key");
});

beforeEach(async () => {
	db = await createTestDb();
});

describe("/admin/agents unread_count token management UI", () => {
	it("issues, reissues, and revokes unread_count tokens with one-time display, no-store, and change_log", async () => {
		const { session } = await openAdminSession(ADMIN_EMAIL, T0);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "予定管理", daily_question_limit: "10" },
			T0 + 1,
		);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "grok", description: "調査担当", daily_question_limit: "10" },
			T0 + 2,
		);
		const museId = await findAgentIdByName("muse");
		const grokId = await findAgentIdByName("grok");

		// Initially unread_count token section shows 未発行 and issue form.
		const beforeIssue = await adminGet(session, "/admin/agents", T0 + 3);
		expect(beforeIssue.response.status).toBe(200);
		expect(beforeIssue.html).toContain(
			"件数確認トークン（<code>unread_count</code>）",
		);
		expect(beforeIssue.html).toContain(`/admin/agents/${museId}/unread-token`);
		expect(beforeIssue.html).toContain("件数確認トークンを発行");

		// Also issue a participant token so we can verify independence.
		const issueParticipant = await adminPost(
			session,
			`/admin/agents/${museId}/token`,
			{},
			T0 + 4,
		);
		const participantToken = extractIssuedToken(issueParticipant.html);

		// Issue unread_count token.
		const firstIssue = await adminPost(
			session,
			`/admin/agents/${museId}/unread-token`,
			{},
			T0 + 10,
		);
		expect(firstIssue.response.status).toBe(200);
		expect(firstIssue.response.headers.get("Cache-Control")).toBe("no-store");
		expect(firstIssue.response.headers.get("Set-Cookie")).toBeNull();
		expect(firstIssue.response.headers.get("Location")).toBeNull();
		expect(firstIssue.html).toContain("今この画面に一度だけ表示されます");
		expect(firstIssue.html).toContain("GET https://paab.test/unread");
		expect(firstIssue.html).toContain("Authorization: Bearer");
		expect(firstIssue.html).toContain("VM 上の定期確認スクリプト");
		expect(firstIssue.html).toContain("未読件数");
		expect(firstIssue.html.match(/<script>/g)).toHaveLength(1);

		const unreadToken1 = extractIssuedToken(firstIssue.html);
		await assertNoTokenLeakInDb(unreadToken1);

		// Subsequent GET /admin/agents shows active metadata & warning, NEVER plaintext.
		const listAfterIssue = await adminGet(session, "/admin/agents", T0 + 15);
		expect(listAfterIssue.response.status).toBe(200);
		expect(listAfterIssue.html).not.toContain(unreadToken1);
		expect(listAfterIssue.html).toContain("件数確認トークンを再発行");
		expect(listAfterIssue.html).toContain("件数確認トークンを失効");
		expect(listAfterIssue.html).toContain(
			"現在有効な件数確認トークンは即座に無効になります",
		);
		expect(listAfterIssue.html).toContain(
			`/admin/agents/${museId}/unread-token/revoke`,
		);
		expect(listAfterIssue.html).toContain(
			`<time datetime="${new Date(T0 + 10).toISOString()}">`,
		);

		// Issued unread_count token works on GET /unread and is rejected on /mcp.
		const schedule = await seedCategory(db, { name: "予定" });
		const submitted = await submitQuestion(db, {
			fromAgentId: grokId,
			toAgentId: museId,
			categoryId: schedule.id,
			body: "明日の予定は？",
			now: T0 + 16,
		});
		expect(submitted.ok).toBe(true);
		const unreadOk = await unreadRawGet(unreadToken1, T0 + 20);
		expect(unreadOk.status).toBe(200);
		expect(await unreadOk.json()).toEqual({ unread: 1 });
		expect((await mcpRawPost(unreadToken1, T0 + 20)).status).toBe(401);

		// Reissue unread_count token immediately invalidates unreadToken1.
		const reissue = await adminPost(
			session,
			`/admin/agents/${museId}/unread-token`,
			{},
			T0 + 30,
		);
		expect(reissue.response.status).toBe(200);
		expect(reissue.response.headers.get("Cache-Control")).toBe("no-store");
		expect(reissue.html).toContain(
			"以前の件数確認トークンは即座に無効になりました",
		);
		const unreadToken2 = extractIssuedToken(reissue.html);
		expect(unreadToken2).not.toBe(unreadToken1);
		await assertNoTokenLeakInDb(unreadToken1);
		await assertNoTokenLeakInDb(unreadToken2);

		expect((await unreadRawGet(unreadToken1, T0 + 35)).status).toBe(401);
		const unread2Res = await unreadRawGet(unreadToken2, T0 + 35);
		expect(unread2Res.status).toBe(200);
		expect(await unread2Res.json()).toEqual({ unread: 1 });

		// Participant token was NOT invalidated by unread_count reissue.
		expect((await mcpRawPost(participantToken, T0 + 35)).status).toBe(200);

		// Delete confirmation page displays unread_count token status.
		const confirmActive = await adminGet(
			session,
			`/admin/agents/${museId}/delete`,
			T0 + 36,
		);
		expect(confirmActive.response.status).toBe(200);
		expect(confirmActive.html).toContain("<strong>件数確認トークン:</strong>");
		expect(confirmActive.html).toContain(
			"有効なトークンあり（同時に削除されます）",
		);

		// Revoke unread_count token immediately invalidates unreadToken2.
		const revoke = await adminPost(
			session,
			`/admin/agents/${museId}/unread-token/revoke`,
			{},
			T0 + 40,
		);
		expect(revoke.response.status).toBe(200);
		expect(revoke.html).toContain("件数確認トークンを失効させました");
		expect((await unreadRawGet(unreadToken2, T0 + 45)).status).toBe(401);
		// Participant token still works.
		expect((await mcpRawPost(participantToken, T0 + 45)).status).toBe(200);

		// Delete confirmation page reflects 未発行 for unread_count after revoke.
		const confirmRevoked = await adminGet(
			session,
			`/admin/agents/${museId}/delete`,
			T0 + 46,
		);
		expect(confirmRevoked.html).toMatch(
			/<strong>件数確認トークン:<\/strong>\s*未発行/,
		);

		// Repeating revoke with no active unread_count token adds no change_log entry.
		const logsBefore = await queryChangeLog(db);
		const revokeAgain = await adminPost(
			session,
			`/admin/agents/${museId}/unread-token/revoke`,
			{},
			T0 + 50,
		);
		expect(revokeAgain.response.status).toBe(200);
		expect(revokeAgain.html).toContain(
			"有効な件数確認トークンはありませんでした",
		);
		const logsAfter = await queryChangeLog(db);
		expect(logsAfter).toHaveLength(logsBefore.length);

		// Verify change_log recorded unread_count issue, reissue, and revoke with owner actor.
		const unreadLogs = logsAfter.filter(
			(entry) =>
				(entry.action === "token_issued" || entry.action === "token_revoked") &&
				((entry.afterJson ?? "").includes('"purpose":"unread_count"') ||
					(entry.beforeJson ?? "").includes('"purpose":"unread_count"')),
		);
		expect(unreadLogs.map((entry) => entry.action)).toEqual([
			"token_revoked",
			"token_issued",
			"token_issued",
		]);
		for (const entry of unreadLogs) {
			expect(entry.actorType).toBe("owner");
			expect(entry.actorId).toBe(ADMIN_EMAIL);
		}
	});

	it("enforces CSRF protection and returns 404 for unknown agent IDs on unread-token endpoints", async () => {
		const { session } = await openAdminSession(ADMIN_EMAIL, T0);
		await adminPost(
			session,
			"/admin/agents",
			{ name: "muse", description: "", daily_question_limit: "5" },
			T0 + 1,
		);
		const museId = await findAgentIdByName("muse");

		// Missing CSRF token on issue -> 403, no token created.
		const noCsrfIssue = await handleAdminRequest(
			new Request(`https://paab.test/admin/agents/${museId}/unread-token`, {
				method: "POST",
				headers: {
					Cookie: session.cookie,
					Origin: "https://paab.test",
					"Cf-Access-Jwt-Assertion": session.jwt,
				},
				body: new URLSearchParams({}),
			}),
			accessEnv(),
			T0 + 2,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrfIssue.status).toBe(403);

		// Issue legitimately, then attempt revoke with invalid CSRF token -> 403, token remains valid.
		const issued = await adminPost(
			session,
			`/admin/agents/${museId}/unread-token`,
			{},
			T0 + 3,
		);
		const token = extractIssuedToken(issued.html);

		const badCsrfRevoke = await handleAdminRequest(
			new Request(
				`https://paab.test/admin/agents/${museId}/unread-token/revoke`,
				{
					method: "POST",
					headers: {
						Cookie: session.cookie,
						Origin: "https://paab.test",
						"Cf-Access-Jwt-Assertion": session.jwt,
					},
					body: new URLSearchParams({ csrf_token: "invalid-token" }),
				},
			),
			accessEnv(),
			T0 + 4,
			{ fetchJwks: session.fetcher },
		);
		expect(badCsrfRevoke.status).toBe(403);
		expect((await unreadRawGet(token, T0 + 5)).status).toBe(200);

		// Missing agent IDs return 404 cleanly.
		const missingId = newId();
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingId}/unread-token`,
					{},
					T0 + 6,
				)
			).response.status,
		).toBe(404);
		expect(
			(
				await adminPost(
					session,
					`/admin/agents/${missingId}/unread-token/revoke`,
					{},
					T0 + 6,
				)
			).response.status,
		).toBe(404);

		// Deleting the agent cascades unread_count token deletion.
		const deleted = await adminPost(
			session,
			`/admin/agents/${museId}/delete`,
			{},
			T0 + 7,
		);
		expect(deleted.response.status).toBe(200);
		expect((await unreadRawGet(token, T0 + 8)).status).toBe(401);
	});
});
