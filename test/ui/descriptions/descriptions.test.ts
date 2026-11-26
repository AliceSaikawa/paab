import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queryChangeLog } from "../../../src/admin";
import { designateAdminBot } from "../../../src/adminbot";
import { issueToken } from "../../../src/auth";
import { insertAllowRule, newId } from "../../../src/db";
import {
	handleAdminRequest,
	type JwkKey,
	type JwksFetcher,
	type UiEnv,
} from "../../../src/ui";
import { createTestDb } from "../../helpers/db";
import { seedAgent, seedCategory, T0 } from "../../helpers/fixtures";
import { call, connect } from "../../mcp/support";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "descriptions-ui-aud";
const OWNER_EMAIL = "owner@example.com";

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

function extractCsrfFromCookie(cookiePair: string): string {
	const eq = cookiePair.indexOf("=");
	if (eq <= 0) {
		throw new Error("Could not find csrf cookie value");
	}
	return cookiePair.slice(eq + 1);
}

async function openDescriptionsSession(
	email = OWNER_EMAIL,
	now = T0,
): Promise<{ session: AdminSession; response: Response; html: string }> {
	const jwt = await signAccessJwt(email, now);
	const fetcher = jwksFetcher();
	const response = await handleAdminRequest(
		new Request("https://paab.test/admin/descriptions", {
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
	const csrfToken = extractCsrfFromCookie(cookie);
	const formMatch = /name="csrf_token" value="([^"]+)"/.exec(html);
	if (formMatch?.[1] !== undefined) {
		expect(formMatch[1]).toBe(csrfToken);
	}
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
	fields: Record<string, string> = {},
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

beforeAll(async () => {
	signingKey = await generateSigningKey("desc-ui-key");
});

beforeEach(async () => {
	db = await createTestDb();
});

describe("/admin/descriptions UI", () => {
	it("fails closed via SELF.fetch, renders empty state, enforces CSP without extra scripts, and escapes HTML", async () => {
		const failClosed = await SELF.fetch("https://paab.test/admin/descriptions");
		expect(failClosed.status).toBe(503);

		const empty = await openDescriptionsSession(OWNER_EMAIL, T0);
		expect(empty.response.status).toBe(200);
		expect(empty.html).toContain(
			'href="/admin/descriptions" aria-current="page"',
		);
		expect(empty.html).toContain("承認待ちの説明文はありません");
		expect(empty.html).not.toContain("この画面はまだ実装されていません");

		const xssAgent = await seedAgent(db, {
			name: "<script>alert('name')</script>",
			description: "<img src=x onerror=alert('cur')>",
		});
		const xssTok = (
			await issueToken(db, {
				agentId: xssAgent.id,
				purpose: "participant",
				now: T0 + 1,
			})
		).token;
		const client = await connect(xssTok, { now: T0 + 2 });
		await call(client, "submit_description", {
			description: "<script>alert('draft')</script>",
		});

		const loaded = await adminGet(empty.session, "/admin/descriptions", T0 + 3);
		expect(loaded.response.status).toBe(200);
		expect(loaded.html).not.toContain("<script>alert('name')</script>");
		expect(loaded.html).not.toContain("<script>alert('draft')</script>");
		expect(loaded.html).not.toContain("<img src=x onerror=alert('cur')>");
		expect(loaded.html).toContain(
			"&lt;script&gt;alert(&#39;draft&#39;)&lt;/script&gt;",
		);
		expect(loaded.html).toContain("<time datetime=");

		// Layout includes only the single CSP-hashed timestamp script.
		const scripts = [
			...loaded.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
		];
		expect(scripts).toHaveLength(1);
		const csp = loaded.response.headers.get("Content-Security-Policy") ?? "";
		const expectedHash = await sha256HeaderValue(scripts[0]?.[1] ?? "");
		expect(csp).toContain(`script-src '${expectedHash}'`);
	});

	it("works when no admin bot is designated: approves and rejects drafts as owner and updates list_agents", async () => {
		const alice = await seedAgent(db, {
			name: "alice",
			description: "alice approved",
		});
		const bob = await seedAgent(db, {
			name: "bob",
			description: "bob v1",
		});
		const schedule = await seedCategory(db, { name: "schedule" });
		await insertAllowRule(db, {
			fromAgentId: alice.id,
			toAgentId: bob.id,
			categoryId: schedule.id,
			createdAt: T0,
		}).run();
		await insertAllowRule(db, {
			fromAgentId: bob.id,
			toAgentId: alice.id,
			categoryId: schedule.id,
			createdAt: T0,
		}).run();

		const aliceTok = (
			await issueToken(db, {
				agentId: alice.id,
				purpose: "participant",
				now: T0,
			})
		).token;
		const bobTok = (
			await issueToken(db, {
				agentId: bob.id,
				purpose: "participant",
				now: T0,
			})
		).token;

		const aliceMcp = await connect(aliceTok, { now: T0 + 10 });
		const bobMcp = await connect(bobTok, { now: T0 + 11 });
		await call(aliceMcp, "submit_description", { description: "alice v2" });
		await call(bobMcp, "submit_description", { description: "bob v2" });

		const { session, html } = await openDescriptionsSession(
			OWNER_EMAIL,
			T0 + 20,
		);
		expect(html).toContain("管理者ボットは指名されていないため");
		expect(html).toContain("alice approved");
		expect(html).toContain("alice v2");
		expect(html).toContain("bob v1");
		expect(html).toContain("bob v2");
		expect(html).toContain(`/admin/descriptions/${alice.id}/approve`);
		expect(html).toContain(`/admin/descriptions/${bob.id}/reject`);

		const approved = await adminPost(
			session,
			`/admin/descriptions/${alice.id}/approve`,
			{},
			T0 + 30,
		);
		expect(approved.response.status).toBe(200);
		expect(approved.html).toContain("「alice」の説明文を承認しました");
		expect(approved.html).not.toContain("alice v2");
		expect(approved.html).toContain("bob v2");

		const rejected = await adminPost(
			session,
			`/admin/descriptions/${bob.id}/reject`,
			{},
			T0 + 40,
		);
		expect(rejected.response.status).toBe(200);
		expect(rejected.html).toContain("「bob」の説明文の提案を却下しました");
		expect(rejected.html).toContain("承認待ちの説明文はありません");

		const bobSeesAlice = await call(bobMcp, "list_agents");
		expect(bobSeesAlice.text).toContain("alice v2");
		expect(bobSeesAlice.text).not.toContain("alice approved");

		const aliceSeesBob = await call(aliceMcp, "list_agents");
		expect(aliceSeesBob.text).toContain("bob v1");
		expect(aliceSeesBob.text).not.toContain("bob v2");

		const logs = await queryChangeLog(db);
		expect(
			logs.map((entry) => ({
				action: entry.action,
				actorType: entry.actorType,
				actorId: entry.actorId,
				targetType: entry.targetType,
				targetId: entry.targetId,
			})),
		).toEqual([
			{
				action: "description_rejected",
				actorType: "owner",
				actorId: OWNER_EMAIL,
				targetType: "description",
				targetId: bob.id,
			},
			{
				action: "description_approved",
				actorType: "owner",
				actorId: OWNER_EMAIL,
				targetType: "description",
				targetId: alice.id,
			},
		]);

		const rulesPage = await adminGet(session, "/admin/rules", T0 + 50);
		expect(rulesPage.response.status).toBe(200);
		expect(rulesPage.html).toContain("説明文承認");
		expect(rulesPage.html).toContain("説明文却下");
		expect(rulesPage.html).toContain("alice v2");
		expect(rulesPage.html).toContain("bob v2");
	});

	it("marks the designated admin bot's own submission and lets the owner approve it from the UI", async () => {
		const muse = await seedAgent(db, {
			name: "muse",
			description: "muse old bio",
		});
		const grok = await seedAgent(db, {
			name: "grok",
			description: "grok bio",
		});
		const schedule = await seedCategory(db, { name: "schedule" });
		await insertAllowRule(db, {
			fromAgentId: grok.id,
			toAgentId: muse.id,
			categoryId: schedule.id,
			createdAt: T0,
		}).run();

		await designateAdminBot(db, {
			agentId: muse.id,
			actor: { actorType: "owner", actorId: OWNER_EMAIL },
			now: T0,
		});

		const museTok = (
			await issueToken(db, {
				agentId: muse.id,
				purpose: "participant",
				now: T0,
			})
		).token;
		const grokTok = (
			await issueToken(db, {
				agentId: grok.id,
				purpose: "participant",
				now: T0,
			})
		).token;

		const museMcp = await connect(museTok, { now: T0 + 5 });
		await call(museMcp, "submit_description", {
			description: "muse owner-approved bio",
		});

		const { session, html } = await openDescriptionsSession(
			OWNER_EMAIL,
			T0 + 10,
		);
		expect(html).toContain("管理者ボット");
		expect(html).toContain(
			"管理者ボット自身の説明文は自己承認できないため、画面から利用者が承認または却下してください",
		);
		expect(html).toContain("muse old bio");
		expect(html).toContain("muse owner-approved bio");

		const approveRes = await adminPost(
			session,
			`/admin/descriptions/${muse.id}/approve`,
			{},
			T0 + 20,
		);
		expect(approveRes.response.status).toBe(200);
		expect(approveRes.html).toContain("「muse」の説明文を承認しました");

		const grokMcp = await connect(grokTok, { now: T0 + 25 });
		const grokList = await call(grokMcp, "list_agents");
		expect(grokList.text).toContain("muse owner-approved bio");
		expect(grokList.text).not.toContain("muse old bio");
	});

	it("returns 404 for missing pending entries and enforces CSRF on POST", async () => {
		const agent = await seedAgent(db, { name: "alice" });
		const { session } = await openDescriptionsSession(OWNER_EMAIL, T0);

		const missingAgent = await adminPost(
			session,
			`/admin/descriptions/${newId()}/approve`,
		);
		expect(missingAgent.response.status).toBe(404);

		const noPending = await adminPost(
			session,
			`/admin/descriptions/${agent.id}/reject`,
		);
		expect(noPending.response.status).toBe(404);

		const noCsrf = await handleAdminRequest(
			new Request(`https://paab.test/admin/descriptions/${agent.id}/approve`, {
				method: "POST",
				headers: {
					Cookie: session.cookie,
					Origin: "https://paab.test",
					"Cf-Access-Jwt-Assertion": session.jwt,
				},
				body: new URLSearchParams(),
			}),
			accessEnv(),
			T0 + 1,
			{ fetchJwks: session.fetcher },
		);
		expect(noCsrf.status).toBe(403);
	});
});
