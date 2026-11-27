import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queryChangeLog, registerAgent } from "../../../src/admin";
import {
	designateAdminBot,
	getAdminBotConfig,
	handleAdminMcpRequest,
	issueAdminBotToken,
} from "../../../src/adminbot";
import { queryAuditLog, recordAuditEvent } from "../../../src/audit";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { HOUR_MS, seedCategory, T0 } from "../../helpers/fixtures";
import { call } from "../../mcp/support";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "adminbot-body-access-ui-aud";
const ADMIN_EMAIL = "owner-admin@example.com";
const ADMIN_MCP_URL = "https://paab.test/mcp/admin";

const CAUTION_TEXT =
	"注意: 本文閲覧をオンにすると、質問文・回答文に含まれる外部テキストを管理者ボットが読むため、プロンプトインジェクションの影響を受けるおそれがあります。";
const RECORDING_DISABLED_NOTICE =
	"が無効のため、このスイッチをオンにしても読める本文はありません。";

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

function accessEnv(recordBodies: "true" | "false" = "false"): UiEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: recordBodies,
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
	uiEnv: UiEnv,
	now = T0,
): Promise<{ session: AdminSession; response: Response; html: string }> {
	const jwt = await signAccessJwt(ADMIN_EMAIL, now);
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
	return { session: { cookie, csrfToken, jwt, fetcher }, response, html };
}

async function adminGet(
	session: AdminSession,
	path: string,
	uiEnv: UiEnv,
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
		uiEnv,
		now,
		{ fetchJwks: session.fetcher },
	);
	return { response, html: await response.text() };
}

async function adminPost(
	session: AdminSession,
	path: string,
	fields: Record<string, string>,
	uiEnv: UiEnv,
	now = T0,
): Promise<{ response: Response; html: string }> {
	const response = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "POST",
			headers: {
				Cookie: session.cookie,
				Origin: "https://paab.test",
				"Cf-Access-Jwt-Assertion": session.jwt,
			},
			body: new URLSearchParams({
				csrf_token: session.csrfToken,
				...fields,
			}),
		}),
		uiEnv,
		now,
		{ fetchJwks: session.fetcher },
	);
	return { response, html: await response.text() };
}

async function connectAdminMcp(
	token: string,
	uiEnv: UiEnv,
	now = T0,
): Promise<Client> {
	const client = new Client({
		name: "paab-ui-body-access",
		version: "0.0.0",
	});
	const transport = new StreamableHTTPClientTransport(new URL(ADMIN_MCP_URL), {
		fetch: (input, init) =>
			handleAdminMcpRequest(new Request(input, init), uiEnv, now),
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	return client;
}

beforeAll(async () => {
	signingKey = await generateSigningKey("adminbot-body-ui-key");
});

beforeEach(async () => {
	db = await createTestDb();
});

describe("/admin/adminbot read_bodies switch UI", () => {
	it("shows the switch with caution and recording notice depending on AUDIT_RECORD_BODIES, toggles ON/OFF, and integrates with /mcp/admin", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const museReg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 10,
			actor: owner,
			now: T0,
		});
		const grokReg = await registerAgent(db, {
			name: "grok",
			dailyQuestionLimit: 10,
			actor: owner,
			now: T0 + 1,
		});
		if (!museReg.ok || !grokReg.ok) {
			throw new Error("Expected agents to register");
		}
		const museId = museReg.data.agent.id;
		const grokId = grokReg.data.agent.id;
		const schedule = await seedCategory(db, { name: "schedule" });

		// Before designation: optional permissions card is hidden and POST returns 409.
		const envOff = accessEnv("false");
		const beforeDesignate = await openAdminBotSession(envOff, T0 + 2);
		expect(beforeDesignate.response.status).toBe(200);
		expect(beforeDesignate.html).not.toContain(
			'action="/admin/adminbot/permissions/read-bodies"',
		);

		const toggleUnset = await adminPost(
			beforeDesignate.session,
			"/admin/adminbot/permissions/read-bodies",
			{ enabled: "1" },
			envOff,
			T0 + 3,
		);
		expect(toggleUnset.response.status).toBe(409);

		// Designate muse and issue admin token.
		await designateAdminBot(db, {
			agentId: museId,
			actor: owner,
			now: T0 + 4,
		});
		const issued = await issueAdminBotToken(db, {
			agentId: museId,
			actor: owner,
			now: T0 + 5,
		});
		if (!issued.ok) throw new Error("Expected admin token");

		// AUDIT_RECORD_BODIES="false": default OFF, shows caution AND disabled-recording notice.
		const pageOff = await adminGet(
			beforeDesignate.session,
			"/admin/adminbot",
			envOff,
			T0 + 6,
		);
		expect(pageOff.response.status).toBe(200);
		expect(pageOff.html).toContain("任意の権限");
		expect(pageOff.html).toContain("本文閲覧");
		expect(pageOff.html).toContain('<span class="badge">オフ</span>');
		expect(pageOff.html).toContain(CAUTION_TEXT);
		expect(pageOff.html).toContain(RECORDING_DISABLED_NOTICE);
		expect(pageOff.html).toContain(
			'action="/admin/adminbot/permissions/read-bodies"',
		);
		expect(pageOff.html).toContain('name="enabled" value="1"');
		expect(pageOff.html).toContain("本文閲覧をオンにする");

		// AUDIT_RECORD_BODIES="true": omits disabled-recording notice, still shows caution.
		const envOn = accessEnv("true");
		const pageOn = await adminGet(
			beforeDesignate.session,
			"/admin/adminbot",
			envOn,
			T0 + 7,
		);
		expect(pageOn.response.status).toBe(200);
		expect(pageOn.html).toContain("本文閲覧");
		expect(pageOn.html).toContain(CAUTION_TEXT);
		expect(pageOn.html).not.toContain(RECORDING_DISABLED_NOTICE);

		// Seed a recorded question body in audit_log.
		const msgId = crypto.randomUUID();
		await recordAuditEvent(
			db,
			{ recordBodies: true, bodyRetentionDays: 30 },
			{
				eventType: "question_accepted",
				occurredAt: T0 + 8,
				fromAgentId: museId,
				toAgentId: grokId,
				categoryId: schedule.id,
				messageId: msgId,
				body: "UI_TOGGLE_VERIFIED_BODY",
			},
		);

		// Toggle ON via CSRF-protected POST.
		const enabledRes = await adminPost(
			beforeDesignate.session,
			"/admin/adminbot/permissions/read-bodies",
			{ enabled: "1" },
			envOn,
			T0 + 10,
		);
		expect(enabledRes.response.status).toBe(200);
		expect(enabledRes.html).toContain("本文閲覧をオンにしました");
		expect(enabledRes.html).toContain(
			'<span class="badge badge-dev">オン</span>',
		);
		expect(enabledRes.html).toContain('name="enabled" value="0"');
		expect(enabledRes.html).toContain("本文閲覧をオフにする");
		expect((await getAdminBotConfig(db)).readBodies).toBe(true);

		// Turning ON again is a no-op with info flash and no extra change_log row.
		const logsAfterOn = await queryChangeLog(db);
		const alreadyOn = await adminPost(
			beforeDesignate.session,
			"/admin/adminbot/permissions/read-bodies",
			{ enabled: "1" },
			envOn,
			T0 + 11,
		);
		expect(alreadyOn.response.status).toBe(200);
		expect(alreadyOn.html).toContain("本文閲覧はすでにオンです");
		expect(await queryChangeLog(db)).toHaveLength(logsAfterOn.length);

		// /mcp/admin view_audit_log can now read the framed body and logs admin_body_read.
		const client = await connectAdminMcp(
			issued.data.token,
			envOn,
			T0 + HOUR_MS,
		);
		const mcpRead = await call(client, "view_audit_log");
		expect(mcpRead.isError).toBe(false);
		expect(mcpRead.text).toContain("UI_TOGGLE_VERIFIED_BODY");
		expect(mcpRead.text).toContain("<untrusted_external_data boundary=");
		expect(
			(await queryAuditLog(db)).filter(
				(entry) => entry.eventType === "admin_body_read",
			),
		).toHaveLength(1);

		// /admin/audit displays the admin_body_read event cleanly.
		const auditPage = await adminGet(
			beforeDesignate.session,
			"/admin/audit",
			envOn,
			T0 + HOUR_MS + 1,
		);
		expect(auditPage.response.status).toBe(200);
		expect(auditPage.html).toContain("admin_body_read");

		// /admin/rules displays the switch change in change_log.
		const rulesPage = await adminGet(
			beforeDesignate.session,
			"/admin/rules",
			envOn,
			T0 + HOUR_MS + 2,
		);
		expect(rulesPage.response.status).toBe(200);
		expect(rulesPage.html).toContain("管理者ボット権限変更");
		expect(rulesPage.html).toContain("本文閲覧=ON");

		// Toggle OFF via CSRF-protected POST.
		const disabledRes = await adminPost(
			beforeDesignate.session,
			"/admin/adminbot/permissions/read-bodies",
			{ enabled: "0" },
			envOn,
			T0 + HOUR_MS + 10,
		);
		expect(disabledRes.response.status).toBe(200);
		expect(disabledRes.html).toContain("本文閲覧をオフにしました");
		expect(disabledRes.html).toContain('<span class="badge">オフ</span>');
		expect((await getAdminBotConfig(db)).readBodies).toBe(false);

		const switchLogs = (await queryChangeLog(db)).filter(
			(entry) => entry.action === "admin_bot_switches_updated",
		);
		expect(switchLogs).toHaveLength(2);
		expect(switchLogs[0]?.actorType).toBe("owner");
		expect(switchLogs[0]?.actorId).toBe(ADMIN_EMAIL);

		// Turning OFF blocks include_body=true again on /mcp/admin.
		const clientAfterOff = await connectAdminMcp(
			issued.data.token,
			envOn,
			T0 + HOUR_MS + 20,
		);
		const deniedAgain = await call(clientAfterOff, "view_audit_log", {
			include_body: true,
		});
		expect(deniedAgain.isError).toBe(true);
		expect(deniedAgain.text).not.toContain("UI_TOGGLE_VERIFIED_BODY");
	});

	it("rejects invalid enabled values with 400 and enforces CSRF on toggle POST", async () => {
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		const reg = await registerAgent(db, {
			name: "muse",
			dailyQuestionLimit: 10,
			actor: owner,
			now: T0,
		});
		if (!reg.ok) throw new Error("Expected agent");
		await designateAdminBot(db, {
			agentId: reg.data.agent.id,
			actor: owner,
			now: T0 + 1,
		});

		const envOn = accessEnv("true");
		const { session } = await openAdminBotSession(envOn, T0 + 2);
		const logsBefore = await queryChangeLog(db);

		for (const badFields of [
			{} as Record<string, string>,
			{ enabled: "" },
			{ enabled: "true" },
			{ enabled: "false" },
			{ enabled: "yes" },
			{ enabled: "2" },
		]) {
			const res = await adminPost(
				session,
				"/admin/adminbot/permissions/read-bodies",
				badFields,
				envOn,
				T0 + 3,
			);
			expect(res.response.status).toBe(400);
			expect(res.html).toContain("本文閲覧スイッチの指定が不正です");
		}
		expect((await getAdminBotConfig(db)).readBodies).toBe(false);
		expect(await queryChangeLog(db)).toHaveLength(logsBefore.length);

		const noCsrf = await handleAdminRequest(
			new Request("https://paab.test/admin/adminbot/permissions/read-bodies", {
				method: "POST",
				headers: {
					Cookie: session.cookie,
					Origin: "https://paab.test",
					"Cf-Access-Jwt-Assertion": session.jwt,
				},
				body: new URLSearchParams({ enabled: "1" }),
			}),
			envOn,
			T0 + 4,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrf.status).toBe(403);
		expect((await getAdminBotConfig(db)).readBodies).toBe(false);
	});
});
