import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queryChangeLog, registerAgent } from "../../../src/admin";
import { handleAdminMcpRequest } from "../../../src/adminbot";
import { hashToken } from "../../../src/auth";
import { newId } from "../../../src/db";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { T0 } from "../../helpers/fixtures";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "adminbot-ui-aud";
const ADMIN_EMAIL = "owner-admin@example.com";
const ADMIN_MCP_URL = "https://paab.test/mcp/admin";

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

async function openAdminBotSession(
	email = ADMIN_EMAIL,
	now = T0,
): Promise<{ session: AdminSession; response: Response; html: string }> {
	const jwt = await signAccessJwt(email, now);
	const fetcher = jwksFetcher();
	const response = await handleAdminRequest(
		new Request("https://paab.test/admin/adminbot", {
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

function extractIssuedToken(htmlText: string): string {
	const match = /<div class="token-box">(paab_[A-Za-z0-9_-]+)<\/div>/.exec(
		htmlText,
	);
	if (!match?.[1]) {
		throw new Error("Could not find issued token in token-box");
	}
	return match[1];
}

async function adminMcpRawPost(token: string, now = T0): Promise<Response> {
	return handleAdminMcpRequest(
		new Request(ADMIN_MCP_URL, {
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

async function connectAdminMcp(token: string, now = T0): Promise<Client> {
	const client = new Client({ name: "paab-ui-adminbot", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(ADMIN_MCP_URL), {
		fetch: (input, init) =>
			handleAdminMcpRequest(new Request(input, init), accessEnv(), now),
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	return client;
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
	signingKey = await generateSigningKey("adminbot-ui-key");
});

beforeEach(async () => {
	db = await createTestDb();
});

describe("/admin/adminbot UI", () => {
	it("shows unconfigured state, designates admin bot, issues one-time token for /mcp/admin, and revokes on switch/clear", async () => {
		const museReg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 10,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0,
		});
		const grokReg = await registerAgent(db, {
			name: "grok",
			dailyQuestionLimit: 10,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0 + 1,
		});
		if (!museReg.ok || !grokReg.ok) {
			throw new Error("Expected agents to register");
		}
		const museId = museReg.data.agent.id;
		const grokId = grokReg.data.agent.id;

		const initial = await openAdminBotSession(ADMIN_EMAIL, T0 + 2);
		expect(initial.response.status).toBe(200);
		expect(initial.response.headers.get("Cache-Control")).toBe("no-store");
		expect(initial.html).toContain("未指名");
		expect(initial.html).toContain(
			"前の管理者ボットの管理者トークンは直ちに失効し",
		);
		expect(initial.html).toContain("管理者ボットを指名");
		expect(initial.html).not.toContain("この画面はまだ実装されていません");

		const designated = await adminPost(
			initial.session,
			"/admin/adminbot/designate",
			{ agent_id: museId },
			T0 + 3,
		);
		expect(designated.response.status).toBe(200);
		expect(designated.html).toContain("「muse」を管理者ボットに指名しました");
		expect(designated.html).toContain("現在の管理者ボット: muse");
		expect(designated.html).toContain("管理者トークンを発行");
		expect(designated.html).toContain("指名を解除する");
		expect(designated.html).toContain("https://paab.test/mcp/admin");

		const issued = await adminPost(
			initial.session,
			"/admin/adminbot/token",
			{ agent_id: museId },
			T0 + 4,
		);
		expect(issued.response.status).toBe(200);
		expect(issued.response.headers.get("Cache-Control")).toBe("no-store");
		expect(issued.response.headers.get("Set-Cookie")).toBeNull();
		expect(issued.response.headers.get("Location")).toBeNull();
		expect(issued.html).toContain("今この画面に一度だけ表示されます");
		expect(issued.html).toContain("https://paab.test/mcp/admin");
		expect(issued.html).toContain("Authorization: Bearer");
		// Layout attaches one CSP-hashed timestamp script; token screens must not inject extra scripts.
		expect(issued.html.match(/<script>/g)).toHaveLength(1);

		const museAdminToken = extractIssuedToken(issued.html);
		await assertNoTokenLeakInDb(museAdminToken);

		const afterIssue = await adminGet(
			initial.session,
			"/admin/adminbot",
			T0 + 5,
		);
		expect(afterIssue.response.status).toBe(200);
		expect(afterIssue.html).not.toContain(museAdminToken);
		expect(afterIssue.html).toContain("管理者トークンを再発行");
		expect(afterIssue.html).toContain("管理者トークンを失効");

		const client = await connectAdminMcp(museAdminToken, T0 + 6);
		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name)).toContain("view_audit_log");
		const auditResult = await client.callTool({
			name: "view_audit_log",
			arguments: {},
		});
		expect(auditResult.isError).toBeFalsy();

		const switched = await adminPost(
			initial.session,
			"/admin/adminbot/designate",
			{ agent_id: grokId },
			T0 + 10,
		);
		expect(switched.response.status).toBe(200);
		expect(switched.html).toContain("「grok」を管理者ボットに指名しました");
		expect(switched.html).toContain("現在の管理者ボット: grok");
		expect(switched.html).toContain("未発行");
		expect((await adminMcpRawPost(museAdminToken, T0 + 11)).status).toBe(401);

		const grokIssued = await adminPost(
			initial.session,
			"/admin/adminbot/token",
			{},
			T0 + 12,
		);
		expect(grokIssued.response.status).toBe(200);
		const grokAdminToken = extractIssuedToken(grokIssued.html);
		await assertNoTokenLeakInDb(grokAdminToken);
		expect((await adminMcpRawPost(grokAdminToken, T0 + 13)).status).toBe(200);

		const revoked = await adminPost(
			initial.session,
			"/admin/adminbot/token/revoke",
			{ agent_id: grokId },
			T0 + 14,
		);
		expect(revoked.response.status).toBe(200);
		expect(revoked.html).toContain("管理者トークンを失効させました");
		expect((await adminMcpRawPost(grokAdminToken, T0 + 15)).status).toBe(401);

		const grokIssued2 = await adminPost(
			initial.session,
			"/admin/adminbot/token",
			{ agent_id: grokId },
			T0 + 16,
		);
		const grokAdminToken2 = extractIssuedToken(grokIssued2.html);
		expect((await adminMcpRawPost(grokAdminToken2, T0 + 17)).status).toBe(200);

		const cleared = await adminPost(
			initial.session,
			"/admin/adminbot/clear",
			{},
			T0 + 18,
		);
		expect(cleared.response.status).toBe(200);
		expect(cleared.html).toContain("管理者ボットの指名を解除しました");
		expect(cleared.html).toContain("未指名");
		expect((await adminMcpRawPost(grokAdminToken2, T0 + 19)).status).toBe(401);

		const rulesPage = await adminGet(initial.session, "/admin/rules", T0 + 20);
		expect(rulesPage.response.status).toBe(200);
		expect(rulesPage.html).toContain("管理者ボット指名");
		expect(rulesPage.html).toContain("管理者ボット解除");

		const logs = await queryChangeLog(db);
		expect(logs.map((entry) => entry.action)).toEqual([
			"admin_bot_cleared",
			"token_issued",
			"token_revoked",
			"token_issued",
			"admin_bot_designated",
			"token_issued",
			"admin_bot_designated",
			"agent_registered",
			"agent_registered",
		]);
		for (const entry of logs) {
			expect(entry.actorType).toBe("owner");
			expect(entry.actorId).toBe(ADMIN_EMAIL);
		}
	});

	it("handles stale agent mismatch, missing agents, validation errors, and CSRF enforcement", async () => {
		const reg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 5,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0,
		});
		if (!reg.ok) throw new Error("Expected agent");
		const museId = reg.data.agent.id;

		const { session } = await openAdminBotSession(ADMIN_EMAIL, T0 + 1);

		const emptyDesignate = await adminPost(
			session,
			"/admin/adminbot/designate",
			{ agent_id: "" },
			T0 + 2,
		);
		expect(emptyDesignate.response.status).toBe(400);

		const missingDesignate = await adminPost(
			session,
			"/admin/adminbot/designate",
			{ agent_id: newId() },
			T0 + 3,
		);
		expect(missingDesignate.response.status).toBe(404);

		const issueWhenUnset = await adminPost(
			session,
			"/admin/adminbot/token",
			{},
			T0 + 4,
		);
		expect(issueWhenUnset.response.status).toBe(400);

		const issueNonDesignated = await adminPost(
			session,
			"/admin/adminbot/token",
			{ agent_id: museId },
			T0 + 5,
		);
		expect(issueNonDesignated.response.status).toBe(409);

		const logsBefore = await queryChangeLog(db);
		const clearWhenUnset = await adminPost(
			session,
			"/admin/adminbot/clear",
			{},
			T0 + 6,
		);
		expect(clearWhenUnset.response.status).toBe(200);
		expect(clearWhenUnset.html).toContain("すでに未指名です");
		expect(await queryChangeLog(db)).toHaveLength(logsBefore.length);

		const noCsrf = await handleAdminRequest(
			new Request("https://paab.test/admin/adminbot/designate", {
				method: "POST",
				headers: {
					Cookie: session.cookie,
					Origin: "https://paab.test",
					"Cf-Access-Jwt-Assertion": session.jwt,
				},
				body: new URLSearchParams({ agent_id: museId }),
			}),
			accessEnv(),
			T0 + 7,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrf.status).toBe(403);
	});
});
