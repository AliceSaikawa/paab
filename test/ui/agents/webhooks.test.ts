import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configureAgentWebhook,
	deleteAgentWebhook,
	listAgentWebhooks,
	queryChangeLog,
	revertAdminBotChange,
	rotateAgentWebhookSecret,
	updateAgent,
} from "../../../src/admin";
import {
	designateAdminBot,
	handleAdminMcpRequest,
} from "../../../src/adminbot";
import { AUDIT_BODY_RECORDING_DISABLED } from "../../../src/audit";
import { issueToken } from "../../../src/auth";
import { handleMcpRequest } from "../../../src/mcp";
import {
	attemptWebhookDelivery,
	enqueueWake,
	type WebhookFetcher,
} from "../../../src/notify";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { seedAgent, T0 } from "../../helpers/fixtures";
import { MCP_URL } from "../../mcp/support";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "agents-webhooks-ui-aud";
const ADMIN_EMAIL = "owner-admin@example.com";
const WHSEC_SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;

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

function extractCsrfToken(html: string): string {
	const match = /name="csrf_token" value="([^"]+)"/.exec(html);
	if (match?.[1] === undefined) {
		throw new Error("CSRF token not found in HTML");
	}
	return match[1];
}

function extractCookiePair(response: Response): string {
	const setCookie = response.headers.get("Set-Cookie");
	if (setCookie === null) {
		throw new Error("Missing Set-Cookie header");
	}
	const pair = setCookie.split(";")[0];
	if (!pair) {
		throw new Error("Invalid Set-Cookie header");
	}
	return pair;
}

function extractTokenBox(html: string): string {
	const match = /<div class="token-box">([^<]+)<\/div>/.exec(html);
	if (match?.[1] === undefined) {
		throw new Error("token-box not found in HTML");
	}
	return match[1];
}

async function openSession(now = T0): Promise<AdminSession> {
	const jwt = await signAccessJwt(ADMIN_EMAIL, now);
	const fetcher = jwksFetcher();
	const res = await handleAdminRequest(
		new Request("https://paab.test/admin/agents", {
			method: "GET",
			headers: { "Cf-Access-Jwt-Assertion": jwt },
		}),
		accessEnv(),
		now,
		{ fetchJwks: fetcher },
	);
	expect(res.status).toBe(200);
	const html = await res.text();
	return {
		cookie: extractCookiePair(res),
		csrfToken: extractCsrfToken(html),
		jwt,
		fetcher,
	};
}

async function adminGet(
	session: AdminSession,
	path: string,
	now = T0,
): Promise<{ status: number; headers: Headers; html: string }> {
	const res = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "GET",
			headers: {
				"Cf-Access-Jwt-Assertion": session.jwt,
				Cookie: session.cookie,
			},
		}),
		accessEnv(),
		now,
		{ fetchJwks: session.fetcher },
	);
	return { status: res.status, headers: res.headers, html: await res.text() };
}

async function adminPost(
	session: AdminSession,
	path: string,
	fields: Record<string, string>,
	now = T0,
	envOverrides: Partial<UiEnv> = {},
): Promise<{ status: number; headers: Headers; html: string }> {
	const body = new URLSearchParams({
		csrf_token: session.csrfToken,
		...fields,
	});
	const res = await handleAdminRequest(
		new Request(`https://paab.test${path}`, {
			method: "POST",
			headers: {
				"Cf-Access-Jwt-Assertion": session.jwt,
				Cookie: session.cookie,
				Origin: "https://paab.test",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
		}),
		accessEnv(envOverrides),
		now,
		{ fetchJwks: session.fetcher },
	);
	return { status: res.status, headers: res.headers, html: await res.text() };
}

beforeAll(async () => {
	signingKey = await generateSigningKey("webhooks-ui-key");
});

beforeEach(async () => {
	db = await createTestDb();
});

describe("/admin/agents webhook UI and admin operations", () => {
	it("configures all 4 auth modes, enforces one-time reveal for paab_hmac only, rotates, deletes, and never leaks secrets", async () => {
		const agent = await seedAgent(db, { name: "grok" });
		const session = await openSession(T0);

		// 1. Configure standard_webhooks (external secret -> NEVER re-displayed).
		const swRes = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook`,
			{
				url: "https://hooks.x.ai/grok-routine",
				auth_mode: "standard_webhooks",
				secret: WHSEC_SECRET,
			},
			T0 + 1,
		);
		expect(swRes.status).toBe(200);
		expect(swRes.headers.get("Cache-Control")).toBe("no-store");
		expect(swRes.html).toContain("https://hooks.x.ai/grok-routine");
		expect(swRes.html).toContain("standard_webhooks");
		expect(swRes.html).not.toContain(WHSEC_SECRET);
		expect(swRes.html).not.toContain('<div class="token-box">');

		// Update URL only while keeping standard_webhooks and leaving secret blank -> preserves secret.
		const swUrlUpdate = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook`,
			{
				url: "https://hooks.x.ai/grok-routine-v2",
				auth_mode: "standard_webhooks",
				secret: "",
			},
			T0 + 2,
		);
		expect(swUrlUpdate.status).toBe(200);
		expect(swUrlUpdate.html).toContain("https://hooks.x.ai/grok-routine-v2");
		expect(swUrlUpdate.html).not.toContain(WHSEC_SECRET);

		// 2. Configure bearer_header (external secret -> NEVER re-displayed).
		const bearerSecret = "manus-bearer-secret-001";
		const bearerRes = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook`,
			{
				url: "https://hooks.manus.im/trigger",
				auth_mode: "bearer_header",
				secret: bearerSecret,
			},
			T0 + 3,
		);
		expect(bearerRes.status).toBe(200);
		expect(bearerRes.html).toContain("https://hooks.manus.im/trigger");
		expect(bearerRes.html).toContain("bearer_header");
		expect(bearerRes.html).not.toContain(bearerSecret);

		// 3. Configure custom_header (external secret -> NEVER re-displayed).
		const customSecret = "cue-custom-secret-002";
		const customRes = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook`,
			{
				url: "https://adapter.example.com/cue",
				auth_mode: "custom_header",
				header_name: "X-Cue-Key",
				secret: customSecret,
			},
			T0 + 4,
		);
		expect(customRes.status).toBe(200);
		expect(customRes.html).toContain("https://adapter.example.com/cue");
		expect(customRes.html).toContain("custom_header");
		expect(customRes.html).toContain("X-Cue-Key");
		expect(customRes.html).not.toContain(customSecret);

		// Rotating on non-paab_hmac is rejected.
		const badRotate = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook/rotate`,
			{},
			T0 + 5,
		);
		expect(badRotate.status).toBe(400);

		// 4. Switch to paab_hmac -> auto-generates and reveals secret ONCE with Cache-Control: no-store.
		const hmacRes = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook`,
			{
				url: "https://receiver.example.com/paab",
				auth_mode: "paab_hmac",
				secret: "",
			},
			T0 + 6,
		);
		expect(hmacRes.status).toBe(200);
		expect(hmacRes.headers.get("Cache-Control")).toBe("no-store");
		const firstHmacSecret = extractTokenBox(hmacRes.html);
		expect(firstHmacSecret).toMatch(/^paab_whsec_[0-9a-f]{64}$/);

		// Subsequent GET /admin/agents NEVER shows the secret again.
		const listAfterCreate = await adminGet(session, "/admin/agents", T0 + 7);
		expect(listAfterCreate.status).toBe(200);
		expect(listAfterCreate.html).toContain("https://receiver.example.com/paab");
		expect(listAfterCreate.html).toContain("paab_hmac");
		expect(listAfterCreate.html).not.toContain(firstHmacSecret);

		// Updating only URL on paab_hmac preserves secret and does NOT reveal it again.
		const hmacUrlUpdate = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook`,
			{
				url: "https://receiver.example.com/paab-v2",
				auth_mode: "paab_hmac",
				secret: "",
			},
			T0 + 8,
		);
		expect(hmacUrlUpdate.status).toBe(200);
		expect(hmacUrlUpdate.html).toContain(
			"https://receiver.example.com/paab-v2",
		);
		expect(hmacUrlUpdate.html).not.toContain(firstHmacSecret);
		expect(hmacUrlUpdate.html).not.toContain('<div class="token-box">');

		// Rotate paab_hmac secret -> reveals new secret once with Cache-Control: no-store.
		const rotateRes = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook/rotate`,
			{},
			T0 + 9,
		);
		expect(rotateRes.status).toBe(200);
		expect(rotateRes.headers.get("Cache-Control")).toBe("no-store");
		const rotatedSecret = extractTokenBox(rotateRes.html);
		expect(rotatedSecret).toMatch(/^paab_whsec_[0-9a-f]{64}$/);
		expect(rotatedSecret).not.toBe(firstHmacSecret);

		// Enqueue a pending delivery and fail once so UI shows latest delivery status & error.
		const deliveryId = await enqueueWake(db, {
			agentId: agent.id,
			now: T0 + 10,
		});
		const failFetcher: WebhookFetcher = vi.fn(
			async () => new Response("nope", { status: 502 }),
		);
		await attemptWebhookDelivery(db, deliveryId as string, {
			now: T0 + 10,
			audit: AUDIT_BODY_RECORDING_DISABLED,
			fetcher: failFetcher,
		});

		const listWithStatus = await adminGet(session, "/admin/agents", T0 + 11);
		expect(listWithStatus.html).toContain("HTTP 502");
		expect(listWithStatus.html).not.toContain(rotatedSecret);

		// Delete webhook -> removes config and pending deliveries.
		const delRes = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook/delete`,
			{},
			T0 + 12,
		);
		expect(delRes.status).toBe(200);
		expect(await listAgentWebhooks(db)).toHaveLength(0);
		const pendingLeft = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM webhook_deliveries WHERE agent_id = ? AND status = 'pending'",
			)
			.bind(agent.id)
			.first<{ n: number }>();
		expect(pendingLeft?.n).toBe(0);

		// Verify change_log entries contain metadata only and ZERO secrets.
		const changes = await queryChangeLog(db);
		const actions = changes.map((c) => c.action);
		expect(actions).toContain("webhook_configured");
		expect(actions).toContain("webhook_secret_rotated");
		expect(actions).toContain("webhook_deleted");
		for (const entry of changes) {
			expect(entry.actorType).toBe("owner");
			expect(entry.actorId).toBe(ADMIN_EMAIL);
			const serialized = `${entry.beforeJson ?? ""}${entry.afterJson ?? ""}`;
			expect(serialized).not.toContain(WHSEC_SECRET);
			expect(serialized).not.toContain(bearerSecret);
			expect(serialized).not.toContain(customSecret);
			expect(serialized).not.toContain(firstHmacSecret);
			expect(serialized).not.toContain(rotatedSecret);
			expect(serialized).not.toContain('"secret"');
		}

		// Verify /admin/rules renders webhook change_log entries cleanly without leaking secrets.
		const rulesPage = await adminGet(session, "/admin/rules", T0 + 13);
		expect(rulesPage.status).toBe(200);
		expect(rulesPage.html).toContain("Webhook設定");
		expect(rulesPage.html).toContain("Webhook鍵ローテーション");
		expect(rulesPage.html).toContain("Webhook削除");
		expect(rulesPage.html).not.toContain(WHSEC_SECRET);
		expect(rulesPage.html).not.toContain(bearerSecret);
		expect(rulesPage.html).not.toContain(customSecret);
		expect(rulesPage.html).not.toContain(firstHmacSecret);
		expect(rulesPage.html).not.toContain(rotatedSecret);
	});

	it("rejects invalid inputs (SSRF URL, bad header, bad whsec_) and enforces owner-only mutations", async () => {
		const agent = await seedAgent(db, { name: "muse" });
		const session = await openSession(T0);

		// SSRF private IP rejected via UI.
		const ssrfRes = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook`,
			{
				url: "https://169.254.169.254/latest/meta-data/",
				auth_mode: "paab_hmac",
			},
			T0 + 1,
		);
		expect(ssrfRes.status).toBe(400);

		// Forbidden custom header rejected.
		const badHeaderRes = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook`,
			{
				url: "https://hooks.example.com/muse",
				auth_mode: "custom_header",
				header_name: "Host",
				secret: "sec",
			},
			T0 + 2,
		);
		expect(badHeaderRes.status).toBe(400);

		// Short whsec_ secret rejected.
		const badWhsecRes = await adminPost(
			session,
			`/admin/agents/${agent.id}/webhook`,
			{
				url: "https://hooks.example.com/muse",
				auth_mode: "standard_webhooks",
				secret: `whsec_${btoa("short")}`,
			},
			T0 + 3,
		);
		expect(badWhsecRes.status).toBe(400);

		// admin_bot actor is rejected by all 3 webhook write operations.
		const botActor = { actorType: "admin_bot" as const, actorId: agent.id };
		expect(
			await configureAgentWebhook(db, {
				agentId: agent.id,
				url: "https://hooks.example.com/muse",
				authMode: "paab_hmac",
				actor: botActor,
				now: T0 + 4,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });

		// Seed valid paab_hmac as owner, then verify admin_bot cannot rotate or delete it.
		expect(
			await configureAgentWebhook(db, {
				agentId: agent.id,
				url: "https://hooks.example.com/muse",
				authMode: "paab_hmac",
				actor: { actorType: "owner", actorId: ADMIN_EMAIL },
				now: T0 + 5,
			}),
		).toMatchObject({ ok: true });

		expect(
			await rotateAgentWebhookSecret(db, {
				agentId: agent.id,
				actor: botActor,
				now: T0 + 6,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });

		expect(
			await deleteAgentWebhook(db, {
				agentId: agent.id,
				actor: botActor,
				now: T0 + 7,
			}),
		).toMatchObject({ ok: false, code: "invalid_input" });
	});

	it("does not block reverting an admin_bot agent update when webhook settings changed afterwards", async () => {
		const agent = await seedAgent(db, {
			name: "muse",
			dailyQuestionLimit: 20,
		});
		const botUpdate = await updateAgent(db, {
			agentId: agent.id,
			dailyQuestionLimit: 10,
			actor: { actorType: "admin_bot", actorId: "admin-bot-1" },
			now: T0 + 1,
		});
		expect(botUpdate.ok).toBe(true);
		if (!botUpdate.ok || botUpdate.changeId === null) {
			throw new Error("Expected changeId from admin_bot update");
		}

		// Configure, rotate, and delete webhook on the same agent afterwards.
		const owner = { actorType: "owner" as const, actorId: ADMIN_EMAIL };
		expect(
			await configureAgentWebhook(db, {
				agentId: agent.id,
				url: "https://hooks.example.com/muse",
				authMode: "paab_hmac",
				actor: owner,
				now: T0 + 2,
			}),
		).toMatchObject({ ok: true });
		expect(
			await rotateAgentWebhookSecret(db, {
				agentId: agent.id,
				actor: owner,
				now: T0 + 3,
			}),
		).toMatchObject({ ok: true });
		expect(
			await deleteAgentWebhook(db, {
				agentId: agent.id,
				actor: owner,
				now: T0 + 4,
			}),
		).toMatchObject({ ok: true });

		// Reverting the earlier admin_bot change succeeds without conflict!
		const reverted = await revertAdminBotChange(db, {
			changeId: botUpdate.changeId,
			actor: owner,
			now: T0 + 5,
		});
		expect(reverted.ok).toBe(true);
	});

	it("exposes NO webhook tools on either /mcp or /mcp/admin", async () => {
		const agent = await seedAgent(db, { name: "admin-bot" });
		const { token: participantToken } = await issueToken(db, {
			agentId: agent.id,
			purpose: "participant",
			now: T0,
		});
		const { token: adminToken } = await issueToken(db, {
			agentId: agent.id,
			purpose: "admin",
			now: T0,
		});
		await designateAdminBot(db, {
			agentId: agent.id,
			actor: { actorType: "owner", actorId: ADMIN_EMAIL },
			now: T0,
		});

		const participantClient = new Client({
			name: "participant-check",
			version: "0.0.0",
		});
		await participantClient.connect(
			new StreamableHTTPClientTransport(new URL(MCP_URL), {
				fetch: (input, init) =>
					handleMcpRequest(new Request(input, init), accessEnv(), T0),
				requestInit: {
					headers: { Authorization: `Bearer ${participantToken}` },
				},
			}),
		);
		const participantTools = await participantClient.listTools();
		expect(
			participantTools.tools.some((t) =>
				t.name.toLowerCase().includes("webhook"),
			),
		).toBe(false);

		const adminClient = new Client({ name: "admin-check", version: "0.0.0" });
		await adminClient.connect(
			new StreamableHTTPClientTransport(
				new URL("https://paab.test/mcp/admin"),
				{
					fetch: (input, init) =>
						handleAdminMcpRequest(new Request(input, init), accessEnv(), T0),
					requestInit: {
						headers: { Authorization: `Bearer ${adminToken}` },
					},
				},
			),
		);
		const adminTools = await adminClient.listTools();
		expect(
			adminTools.tools.some((t) => t.name.toLowerCase().includes("webhook")),
		).toBe(false);
	});
});
