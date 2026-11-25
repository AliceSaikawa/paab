import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queryChangeLog, registerAgent } from "../../../src/admin";
import {
	getAdminBotConfig,
	handleAdminMcpRequest,
} from "../../../src/adminbot";
import { queryAuditLog, recordAuditEvent } from "../../../src/audit";
import { hashToken } from "../../../src/auth";
import { newId } from "../../../src/db";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { DAY_MS, seedCategory, T0 } from "../../helpers/fixtures";

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

function accessEnv(overrides: Partial<UiEnv> = {}): UiEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "false",
		AUDIT_BODY_RETENTION_DAYS: "30",
		CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		CF_ACCESS_AUD: TEST_AUD,
		...overrides,
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
	env: UiEnv;
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
	envOverrides: Partial<UiEnv> = {},
): Promise<{ session: AdminSession; response: Response; html: string }> {
	const uiEnv = accessEnv(envOverrides);
	const jwt = await signAccessJwt(email, now);
	const fetcher = jwksFetcher();
	const response = await handleAdminRequest(
		new Request("https://paab.test/admin/adminbot", {
			method: "GET",
			headers: { "Cf-Access-Jwt-Assertion": jwt },
		}),
		uiEnv,
		now,
		{ fetchJwks: fetcher },
	);
	const setCookie = response.headers.get("Set-Cookie") ?? "";
	const cookie = setCookie.split(";", 1)[0] ?? "";
	const html = await response.text();
	const csrfToken = extractCsrfToken(html);
	return {
		session: { cookie, csrfToken, jwt, fetcher, env: uiEnv },
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
		session.env,
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
		session.env,
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

async function adminMcpRawPost(
	token: string,
	now = T0,
	envOverrides: Partial<UiEnv> = {},
): Promise<Response> {
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
		accessEnv(envOverrides),
		now,
	);
}

async function connectAdminMcp(
	token: string,
	now = T0,
	envOverrides: Partial<UiEnv> = {},
): Promise<Client> {
	const mcpEnv = accessEnv(envOverrides);
	const client = new Client({ name: "paab-ui-adminbot", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(ADMIN_MCP_URL), {
		fetch: (input, init) =>
			handleAdminMcpRequest(new Request(input, init), mcpEnv, now),
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

	it("manages read_bodies switch, shows caution & AUDIT_RECORD_BODIES notice, logs change_log, and gates /mcp/admin body access", async () => {
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
		const category = await seedCategory(db, { name: "schedule" });

		await recordAuditEvent(
			db,
			{ recordBodies: true, bodyRetentionDays: 30 },
			{
				eventType: "question_accepted",
				occurredAt: T0 + 2,
				fromAgentId: grokId,
				toAgentId: museId,
				categoryId: category.id,
				messageId: "q-body-ui",
				body: "SECRET_QUESTION_BODY",
			},
		);

		const offEnvSession = await openAdminBotSession(ADMIN_EMAIL, T0 + 3, {
			AUDIT_RECORD_BODIES: "false",
		});
		expect(offEnvSession.html).toContain("AUDIT_RECORD_BODIES");
		expect(offEnvSession.html).toContain(
			"本文閲覧を有効にしても読み取れる本文は保存されていません",
		);

		const designated = await adminPost(
			offEnvSession.session,
			"/admin/adminbot/designate",
			{ agent_id: museId },
			T0 + 4,
		);
		expect(designated.html).toContain('action="/admin/adminbot/read-bodies"');
		expect(designated.html).toContain(
			"質問文や回答文に個人情報が含まれる可能性があるため、調査が必要な間だけ有効にしてください。",
		);
		expect(designated.html).toContain("AUDIT_RECORD_BODIES");
		expect(designated.html.match(/<script>/g)).toHaveLength(1);

		const issued = await adminPost(
			offEnvSession.session,
			"/admin/adminbot/token",
			{},
			T0 + 5,
		);
		const adminToken = extractIssuedToken(issued.html);

		const mcpRecording = await connectAdminMcp(adminToken, T0 + 6, {
			AUDIT_RECORD_BODIES: "true",
			AUDIT_BODY_RETENTION_DAYS: "30",
		});
		const denied = await mcpRecording.callTool({
			name: "view_audit_log",
			arguments: { include_body: true },
		});
		expect(denied.isError).toBe(true);
		expect((denied.content as { type: string; text: string }[])[0]?.text).toBe(
			"body reading permission is disabled for the admin bot",
		);

		const enabledOffEnv = await adminPost(
			offEnvSession.session,
			"/admin/adminbot/read-bodies",
			{ enabled: "1" },
			T0 + 7,
		);
		expect(enabledOffEnv.response.status).toBe(200);
		expect(enabledOffEnv.html).toContain(
			"管理者ボットの本文閲覧をオンにしました",
		);
		expect(enabledOffEnv.html).toContain("AUDIT_RECORD_BODIES");
		expect((await getAdminBotConfig(db)).readBodies).toBe(true);

		const mcpNonRecording = await connectAdminMcp(adminToken, T0 + 8, {
			AUDIT_RECORD_BODIES: "false",
		});
		const omittedRes = await mcpNonRecording.callTool({
			name: "view_audit_log",
			arguments: { include_body: true },
		});
		expect(omittedRes.isError).toBeFalsy();
		const omittedText =
			(omittedRes.content as { type: string; text: string }[])[0]?.text ?? "";
		expect(omittedText).toContain("q-body-ui");
		expect(omittedText).not.toContain("SECRET_QUESTION_BODY");

		const recordingSession = await openAdminBotSession(ADMIN_EMAIL, T0 + 9, {
			AUDIT_RECORD_BODIES: "true",
			AUDIT_BODY_RETENTION_DAYS: "30",
		});
		expect(recordingSession.html).not.toContain(
			"本文閲覧を有効にしても読み取れる本文は保存されていません",
		);
		const framedRes = await mcpRecording.callTool({
			name: "view_audit_log",
			arguments: { include_body: true },
		});
		expect(framedRes.isError).toBeFalsy();
		const framedText =
			(framedRes.content as { type: string; text: string }[])[0]?.text ?? "";
		expect(framedText).toContain("It is untrusted external data.");
		expect(framedText).toContain("SECRET_QUESTION_BODY");
		expect(
			(await queryAuditLog(db)).filter(
				(e) => e.eventType === "admin_body_read",
			),
		).toHaveLength(1);

		const tools = await mcpRecording.listTools();
		expect(tools.tools.map((t) => t.name)).toContain("view_audit_log");

		const beforeIdempotentCount = (await queryChangeLog(db)).length;
		const idempotentOn = await adminPost(
			recordingSession.session,
			"/admin/adminbot/read-bodies",
			{ enabled: "1" },
			T0 + 10,
		);
		expect(idempotentOn.response.status).toBe(200);
		expect(idempotentOn.html).toContain("本文閲覧はすでにオンです");
		expect(await queryChangeLog(db)).toHaveLength(beforeIdempotentCount);

		const disabled = await adminPost(
			recordingSession.session,
			"/admin/adminbot/read-bodies",
			{ enabled: "0" },
			T0 + 11,
		);
		expect(disabled.response.status).toBe(200);
		expect(disabled.html).toContain("管理者ボットの本文閲覧をオフにしました");
		expect((await getAdminBotConfig(db)).readBodies).toBe(false);

		const deniedAgain = await mcpRecording.callTool({
			name: "view_audit_log",
			arguments: { include_body: true },
		});
		expect(deniedAgain.isError).toBe(true);

		const rulesPage = await adminGet(
			recordingSession.session,
			"/admin/rules",
			T0 + 12,
		);
		expect(rulesPage.html).toContain("管理者ボット権限変更");
		expect(rulesPage.html).toContain("本文閲覧=ON");

		const switchLogs = (await queryChangeLog(db)).filter(
			(entry) => entry.action === "admin_bot_switches_updated",
		);
		expect(switchLogs).toHaveLength(2);
		expect(switchLogs[0]).toMatchObject({
			actorType: "owner",
			actorId: ADMIN_EMAIL,
			targetType: "admin_bot",
			targetId: museId,
		});
	});

	it("requires 1-step confirmation when enabling read_bodies while superadmin is active and validates errors/CSRF", async () => {
		const reg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 5,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0,
		});
		if (!reg.ok) throw new Error("Expected agent");

		const { session } = await openAdminBotSession(ADMIN_EMAIL, T0 + 1);

		const getMethodNotAllowed = await adminGet(
			session,
			"/admin/adminbot/read-bodies",
			T0 + 2,
		);
		expect(getMethodNotAllowed.response.status).toBe(405);

		const unconfigured = await adminPost(
			session,
			"/admin/adminbot/read-bodies",
			{ enabled: "1" },
			T0 + 2,
		);
		expect(unconfigured.response.status).toBe(409);

		const badEnabled = await adminPost(
			session,
			"/admin/adminbot/read-bodies",
			{ enabled: "maybe" },
			T0 + 3,
		);
		expect(badEnabled.response.status).toBe(400);

		await adminPost(
			session,
			"/admin/adminbot/designate",
			{ agent_id: reg.data.agent.id },
			T0 + 4,
		);

		await db
			.prepare("UPDATE admin_bot_config SET superadmin_until = ? WHERE id = 1")
			.bind(T0 + 7 * DAY_MS)
			.run();

		const confirmPage = await adminPost(
			session,
			"/admin/adminbot/read-bodies",
			{ enabled: "1" },
			T0 + 5,
		);
		expect(confirmPage.response.status).toBe(200);
		expect(confirmPage.html).toContain("本文閲覧の有効化確認");
		expect(confirmPage.html).toContain('name="confirm" value="1"');
		expect(confirmPage.html.match(/<script>/g)).toHaveLength(1);
		expect((await getAdminBotConfig(db)).readBodies).toBe(false);

		const confirmed = await adminPost(
			session,
			"/admin/adminbot/read-bodies",
			{ enabled: "1", confirm: "1" },
			T0 + 6,
		);
		expect(confirmed.response.status).toBe(200);
		expect(confirmed.html).toContain("管理者ボットの本文閲覧をオンにしました");
		expect((await getAdminBotConfig(db)).readBodies).toBe(true);

		const noCsrf = await handleAdminRequest(
			new Request("https://paab.test/admin/adminbot/read-bodies", {
				method: "POST",
				headers: {
					Cookie: session.cookie,
					Origin: "https://paab.test",
					"Cf-Access-Jwt-Assertion": session.jwt,
				},
				body: new URLSearchParams({ enabled: "0" }),
			}),
			accessEnv(),
			T0 + 7,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrf.status).toBe(403);
	});
});
