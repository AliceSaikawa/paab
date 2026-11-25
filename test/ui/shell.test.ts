import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	ADMIN_NAV_TABS,
	type AdminRoute,
	adminPageResponse,
	clearJwksCache,
	csrfCookieName,
	csrfInput,
	escapeHtml,
	formatTimestamp,
	type HtmlValue,
	handleAdminRequest,
	html,
	type JwkKey,
	type JwksFetcher,
	normalizeTeamDomain,
	placeholderRoute,
	rawHtml,
	type UiEnv,
	verifyAccessRequest,
} from "../../src/ui";
import { createTestDb } from "../helpers/db";
import { T0 } from "../helpers/fixtures";

const TEAM_DOMAIN = "paab-team.cloudflareaccess.com";
const TEST_AUD = "test-aud-tag-123456";
const NOW_MS = T0;
const NOW_SEC = Math.floor(NOW_MS / 1000);

interface SigningKeyPair {
	kid: string;
	privateKey: CryptoKey;
	jwk: JwkKey;
}

let primaryKey: SigningKeyPair;
let secondaryKey: SigningKeyPair;

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

async function signJwt(
	key: SigningKeyPair,
	payload: Record<string, unknown>,
	headerOverrides: Record<string, unknown> = {},
): Promise<string> {
	const header = { alg: "RS256", typ: "JWT", kid: key.kid, ...headerOverrides };
	const headerB64 = toBase64Url(JSON.stringify(header));
	const payloadB64 = toBase64Url(JSON.stringify(payload));
	const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key.privateKey,
		signingInput,
	);
	return `${headerB64}.${payloadB64}.${toBase64Url(new Uint8Array(signature))}`;
}

function prodEnv(overrides: Partial<UiEnv> = {}): UiEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "false",
		AUDIT_BODY_RETENTION_DAYS: "30",
		CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		CF_ACCESS_AUD: TEST_AUD,
		...overrides,
	};
}

function devEnv(devUser = "owner@example.com"): UiEnv {
	return {
		DB: env.DB,
		AUDIT_RECORD_BODIES: "false",
		AUDIT_BODY_RETENTION_DAYS: "30",
		CF_ACCESS_TEAM_DOMAIN: "",
		CF_ACCESS_AUD: "",
		ADMIN_DEV_USER: devUser,
	};
}

function jwksFor(...keys: SigningKeyPair[]): JwksFetcher {
	const document = { keys: keys.map((key) => key.jwk) };
	return vi.fn(async () => document);
}

function adminGet(
	url = "https://paab.test/admin",
	headers: Record<string, string> = {},
): Request {
	return new Request(url, { method: "GET", headers });
}

function extractCsrfCookiePair(setCookie: string): string {
	return setCookie.split(";", 1)[0] ?? "";
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
	primaryKey = await generateSigningKey("key-1");
	secondaryKey = await generateSigningKey("key-2");
	clearJwksCache();
});

describe("HTML escaping", () => {
	it("escapes all five special characters in text and attributes", () => {
		expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
			"&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;",
		);
	});

	it("escapes interpolated strings while preserving SafeHtml and arrays", () => {
		const untrusted = '<img src=x onerror="alert(1)">';
		const badge = html`<span class="badge">${"ok & <safe>"}</span>`;
		const items: HtmlValue[] = [
			"<b>one</b>",
			html`<em>two</em>`,
			false,
			null,
			undefined,
			42,
		];
		const rendered = html`<div>${untrusted}${badge}${items}</div>`;

		expect(rendered.html).toBe(
			'<div>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;<span class="badge">ok &amp; &lt;safe&gt;</span>&lt;b&gt;one&lt;/b&gt;<em>two</em>42</div>',
		);
	});

	it("rejects forged plain objects that pretend to be SafeHtml", () => {
		const forged = { html: "<script>evil()</script>" };
		const rendered = html`<div>${forged as unknown as string}</div>`;
		expect(rendered.html).not.toContain("<script>");
	});
});

describe("Cloudflare Access JWT verification", () => {
	it("accepts a valid RS256 Access JWT and verifies aud as string or array", async () => {
		const tokenStringAud = await signJwt(primaryKey, {
			aud: TEST_AUD,
			exp: NOW_SEC + 300,
			nbf: NOW_SEC - 10,
			email: "alice@example.com",
			sub: "user-123",
		});
		const fetcher = jwksFor(primaryKey);

		const res1 = await handleAdminRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": tokenStringAud,
			}),
			prodEnv({ CF_ACCESS_TEAM_DOMAIN: `https://${TEAM_DOMAIN}/` }),
			NOW_MS,
			{ fetchJwks: fetcher },
		);

		expect(res1.status).toBe(200);
		expect(fetcher).toHaveBeenCalledWith(
			`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`,
		);
		const body = await res1.text();
		expect(body).toContain("alice@example.com");
		expect(body).not.toContain("開発モード");

		const tokenArrayAud = await signJwt(primaryKey, {
			aud: ["other-aud", TEST_AUD],
			exp: NOW_SEC + 300,
			email: "alice@example.com",
			sub: "user-123",
		});
		const res2 = await verifyAccessRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": tokenArrayAud,
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks: fetcher },
		);
		expect(res2).toEqual({
			ok: true,
			user: { email: "alice@example.com", sub: "user-123" },
			devMode: false,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("caches JWKS by kid and refetches once on key rotation", async () => {
		let keys = [primaryKey.jwk];
		const fetchJwks = vi.fn(async () => ({ keys }));

		const token1 = await signJwt(primaryKey, {
			aud: TEST_AUD,
			exp: NOW_SEC + 300,
			email: "owner@example.com",
			sub: "u1",
		});
		const token2 = await signJwt(secondaryKey, {
			aud: TEST_AUD,
			exp: NOW_SEC + 300,
			email: "owner@example.com",
			sub: "u1",
		});

		const first = await verifyAccessRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": token1,
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks },
		);
		expect(first.ok).toBe(true);
		expect(fetchJwks).toHaveBeenCalledTimes(1);

		keys = [primaryKey.jwk, secondaryKey.jwk];
		const second = await verifyAccessRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": token2,
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks },
		);
		expect(second.ok).toBe(true);
		expect(fetchJwks).toHaveBeenCalledTimes(2);

		const unknownKid = await signJwt(
			{ ...secondaryKey, kid: "missing-kid" },
			{
				aud: TEST_AUD,
				exp: NOW_SEC + 300,
				email: "owner@example.com",
				sub: "u1",
			},
		);
		const third = await verifyAccessRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": unknownKid,
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks },
		);
		expect(third.ok).toBe(false);
		if (!third.ok) {
			expect(third.status).toBe(403);
		}
		expect(fetchJwks).toHaveBeenCalledTimes(3);
	});

	it("rejects missing header, expired, not-yet-valid, wrong aud, bad alg, and tampered signature with 403", async () => {
		const fetcher = jwksFor(primaryKey);

		const missing = await handleAdminRequest(adminGet(), prodEnv(), NOW_MS, {
			fetchJwks: fetcher,
		});
		expect(missing.status).toBe(403);

		const expiredJwt = await signJwt(primaryKey, {
			aud: TEST_AUD,
			exp: NOW_SEC,
			email: "owner@example.com",
			sub: "u1",
		});
		const expired = await handleAdminRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": expiredJwt,
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks: fetcher },
		);
		expect(expired.status).toBe(403);

		const futureJwt = await signJwt(primaryKey, {
			aud: TEST_AUD,
			exp: NOW_SEC + 600,
			nbf: NOW_SEC + 60,
			email: "owner@example.com",
			sub: "u1",
		});
		const notYetValid = await handleAdminRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": futureJwt,
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks: fetcher },
		);
		expect(notYetValid.status).toBe(403);

		const wrongAudJwt = await signJwt(primaryKey, {
			aud: "different-aud",
			exp: NOW_SEC + 300,
			email: "owner@example.com",
			sub: "u1",
		});
		const wrongAud = await handleAdminRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": wrongAudJwt,
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks: fetcher },
		);
		expect(wrongAud.status).toBe(403);

		const algNoneJwt = await signJwt(
			primaryKey,
			{ aud: TEST_AUD, exp: NOW_SEC + 300, email: "owner@example.com" },
			{ alg: "none" },
		);
		const badAlg = await handleAdminRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": algNoneJwt,
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks: fetcher },
		);
		expect(badAlg.status).toBe(403);

		const validJwt = await signJwt(primaryKey, {
			aud: TEST_AUD,
			exp: NOW_SEC + 300,
			email: "owner@example.com",
			sub: "u1",
		});
		const parts = validJwt.split(".");
		const tamperedPayload = toBase64Url(
			JSON.stringify({
				aud: TEST_AUD,
				exp: NOW_SEC + 300,
				email: "attacker@example.com",
				sub: "u1",
			}),
		);
		const tampered = await handleAdminRequest(
			adminGet("https://paab.test/admin", {
				"Cf-Access-Jwt-Assertion": `${parts[0]}.${tamperedPayload}.${parts[2]}`,
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks: fetcher },
		);
		expect(tampered.status).toBe(403);
	});

	it("fails closed with 503 when unconfigured or partially configured, even if ADMIN_DEV_USER is set", async () => {
		const unconfigured = await handleAdminRequest(
			adminGet(),
			{
				DB: env.DB,
				CF_ACCESS_TEAM_DOMAIN: "",
				CF_ACCESS_AUD: "",
			},
			NOW_MS,
		);
		expect(unconfigured.status).toBe(503);
		expect(await unconfigured.text()).toContain(
			"Cloudflare Access が設定されていません",
		);

		const onlyDomain = await handleAdminRequest(
			adminGet(),
			{
				DB: env.DB,
				CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
				CF_ACCESS_AUD: "",
				ADMIN_DEV_USER: "owner@example.com",
			},
			NOW_MS,
		);
		expect(onlyDomain.status).toBe(503);

		const onlyAud = await handleAdminRequest(
			adminGet(),
			{
				DB: env.DB,
				CF_ACCESS_TEAM_DOMAIN: "",
				CF_ACCESS_AUD: TEST_AUD,
				ADMIN_DEV_USER: "owner@example.com",
			},
			NOW_MS,
		);
		expect(onlyAud.status).toBe(503);
	});

	it("allows ADMIN_DEV_USER only when Access vars are unset, and rejects it when Access vars are set", async () => {
		const devRes = await handleAdminRequest(adminGet(), devEnv(), NOW_MS);
		expect(devRes.status).toBe(200);
		const devBody = await devRes.text();
		expect(devBody).toContain("owner@example.com");
		expect(devBody).toContain("開発モード");

		const prodWithDevUser = await handleAdminRequest(
			adminGet(),
			prodEnv({ ADMIN_DEV_USER: "owner@example.com" }),
			NOW_MS,
			{ fetchJwks: jwksFor(primaryKey) },
		);
		expect(prodWithDevUser.status).toBe(403);
	});

	it("rejects malformed CF_ACCESS_TEAM_DOMAIN values", async () => {
		expect(normalizeTeamDomain("https://myteam.cloudflareaccess.com/")).toBe(
			"myteam.cloudflareaccess.com",
		);
		expect(
			normalizeTeamDomain("http://myteam.cloudflareaccess.com"),
		).toBeNull();
		expect(normalizeTeamDomain("myteam.cloudflareaccess.com/path")).toBeNull();
		expect(normalizeTeamDomain("myteam.cloudflareaccess.com?a=1")).toBeNull();
		expect(normalizeTeamDomain("user@myteam.cloudflareaccess.com")).toBeNull();
		expect(normalizeTeamDomain("myteam.cloudflareaccess.com:8443")).toBeNull();
		expect(normalizeTeamDomain("127.0.0.1")).toBeNull();

		const badDomain = await handleAdminRequest(
			adminGet(),
			prodEnv({ CF_ACCESS_TEAM_DOMAIN: "https://evil.example/path" }),
			NOW_MS,
		);
		expect(badDomain.status).toBe(503);
	});
});

describe("CSRF protection, routing, and security headers", () => {
	it("sets protocol-appropriate CSRF cookies on GET and enforces CSRF on POST", async () => {
		const postSpy = vi.fn((ctx) =>
			adminPageResponse({
				title: "更新",
				currentPath: ctx.url.pathname,
				user: ctx.user,
				devMode: ctx.devMode,
				flash: { kind: "success", message: `保存: ${ctx.form.get("name")}` },
				body: html`<p>done</p>`,
			}),
		);
		const testRoutes: AdminRoute[] = [
			{
				pattern: "/admin/test-action",
				get: (ctx) =>
					adminPageResponse({
						title: "テスト",
						currentPath: ctx.url.pathname,
						user: ctx.user,
						devMode: ctx.devMode,
						body: html`<form method="POST" action="/admin/test-action">${csrfInput(ctx.csrfToken)}<input type="text" name="name" value="x"></form>`,
					}),
				post: postSpy,
			},
		];

		const httpsGet = await handleAdminRequest(
			adminGet("https://paab.test/admin/test-action"),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(httpsGet.status).toBe(200);
		const httpsCookie = httpsGet.headers.get("Set-Cookie") ?? "";
		expect(httpsCookie).toContain("__Host-paab_csrf=");
		expect(httpsCookie).toContain("Path=/");
		expect(httpsCookie).toContain("HttpOnly");
		expect(httpsCookie).toContain("SameSite=Lax");
		expect(httpsCookie).toContain("Secure");
		expect(httpsCookie).not.toContain("Domain=");

		const cookiePair = extractCsrfCookiePair(httpsCookie);
		const htmlText = await httpsGet.text();
		const tokenMatch = /name="csrf_token" value="([^"]+)"/.exec(htmlText);
		expect(tokenMatch?.[1]).toBeTruthy();
		const csrfToken = tokenMatch?.[1] ?? "";

		const secondGet = await handleAdminRequest(
			adminGet("https://paab.test/admin/test-action", { Cookie: cookiePair }),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(secondGet.headers.get("Set-Cookie")).toBeNull();

		const httpGet = await handleAdminRequest(
			adminGet("http://localhost:8787/admin/test-action"),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		const httpCookie = httpGet.headers.get("Set-Cookie") ?? "";
		expect(httpCookie).toContain("paab_csrf=");
		expect(httpCookie).toContain("Path=/admin");
		expect(httpCookie).not.toContain("Secure");
		expect(csrfCookieName(new URL("https://paab.test"))).toBe(
			"__Host-paab_csrf",
		);
		expect(csrfCookieName(new URL("http://localhost:8787"))).toBe("paab_csrf");

		const okPost = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", {
				method: "POST",
				headers: {
					Cookie: cookiePair,
					Origin: "https://paab.test",
				},
				body: new URLSearchParams({ csrf_token: csrfToken, name: "muse" }),
			}),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(okPost.status).toBe(200);
		expect(postSpy).toHaveBeenCalledTimes(1);
		expect(await okPost.text()).toContain("保存: muse");

		const noCookiePost = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", {
				method: "POST",
				headers: { Origin: "https://paab.test" },
				body: new URLSearchParams({ csrf_token: csrfToken }),
			}),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(noCookiePost.status).toBe(403);

		const noFieldPost = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", {
				method: "POST",
				headers: { Cookie: cookiePair, Origin: "https://paab.test" },
				body: new URLSearchParams({ name: "muse" }),
			}),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(noFieldPost.status).toBe(403);

		const wrongTokenPost = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", {
				method: "POST",
				headers: { Cookie: cookiePair, Origin: "https://paab.test" },
				body: new URLSearchParams({
					csrf_token: "A".repeat(43),
				}),
			}),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(wrongTokenPost.status).toBe(403);

		const crossOriginPost = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", {
				method: "POST",
				headers: {
					Cookie: cookiePair,
					Origin: "https://evil.example",
				},
				body: new URLSearchParams({ csrf_token: csrfToken }),
			}),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(crossOriginPost.status).toBe(403);

		const nullOriginPost = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", {
				method: "POST",
				headers: {
					Cookie: cookiePair,
					Origin: "null",
				},
				body: new URLSearchParams({ csrf_token: csrfToken }),
			}),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(nullOriginPost.status).toBe(403);

		const crossRefererPost = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", {
				method: "POST",
				headers: {
					Cookie: cookiePair,
					Referer: "https://evil.example/csrf",
				},
				body: new URLSearchParams({ csrf_token: csrfToken }),
			}),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(crossRefererPost.status).toBe(403);

		const putReq = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", { method: "PUT" }),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(putReq.status).toBe(405);

		const unauthedPost = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", {
				method: "POST",
				headers: {
					Cookie: cookiePair,
					Origin: "https://paab.test",
				},
				body: new URLSearchParams({ csrf_token: csrfToken, name: "muse" }),
			}),
			prodEnv(),
			NOW_MS,
			{ fetchJwks: jwksFor(primaryKey), routes: testRoutes },
		);
		expect(unauthedPost.status).toBe(403);

		const wrongContentTypePost = await handleAdminRequest(
			new Request("https://paab.test/admin/test-action", {
				method: "POST",
				headers: {
					Cookie: cookiePair,
					Origin: "https://paab.test",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ csrf_token: csrfToken }),
			}),
			devEnv(),
			NOW_MS,
			{ routes: testRoutes },
		);
		expect(wrongContentTypePost.status).toBe(415);

		const paramRoutes: AdminRoute[] = [
			{
				pattern: "/admin/items/:id/action",
				post: (ctx) =>
					adminPageResponse({
						title: "詳細",
						currentPath: ctx.url.pathname,
						user: ctx.user,
						devMode: ctx.devMode,
						body: html`<p>${ctx.params.id}</p>`,
					}),
			},
		];
		const paramPost = await handleAdminRequest(
			new Request("https://paab.test/admin/items/agent-123/action", {
				method: "POST",
				headers: {
					Cookie: cookiePair,
					Origin: "https://paab.test",
				},
				body: new URLSearchParams({ csrf_token: csrfToken }),
			}),
			devEnv(),
			NOW_MS,
			{ routes: paramRoutes },
		);
		expect(paramPost.status).toBe(200);
		expect(await paramPost.text()).toContain("<p>agent-123</p>");

		expect(postSpy).toHaveBeenCalledTimes(1);
	});

	it("renders layout with navigation tabs, timestamp element, and matching CSP script hash", async () => {
		const response = await handleAdminRequest(
			adminGet("https://paab.test/admin"),
			devEnv(),
			NOW_MS,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/html; charset=utf-8",
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");

		const csp = response.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).toContain("style-src 'unsafe-inline'");

		const body = await response.text();
		expect(body).toContain('<html lang="ja">');
		for (const tab of ADMIN_NAV_TABS) {
			expect(body).toContain(`href="${tab.href}"`);
		}

		const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(body);
		expect(scriptMatch?.[1]).toBeTruthy();
		const expectedHash = await sha256HeaderValue(scriptMatch?.[1] ?? "");
		expect(csp).toContain(`script-src '${expectedHash}'`);

		const timeHtml = formatTimestamp(NOW_MS);
		expect(timeHtml.html).toContain("<time datetime=");
	});

	it("implements all nav tabs, renders 501 for placeholder routes, and 404 for unknown paths", async () => {
		await createTestDb();

		for (const tab of ADMIN_NAV_TABS) {
			const liveRes = await handleAdminRequest(
				adminGet(`https://paab.test${tab.href}`),
				devEnv(),
				NOW_MS,
			);
			expect(liveRes.status).toBe(200);
		}

		const tabRes = await handleAdminRequest(
			adminGet("https://paab.test/admin/descriptions"),
			devEnv(),
			NOW_MS,
			{ routes: [placeholderRoute("/admin/descriptions", "説明文審査")] },
		);
		expect(tabRes.status).toBe(501);
		const tabHtml = await tabRes.text();
		expect(tabHtml).toContain("この画面はまだ実装されていません");
		expect(tabHtml).toContain('href="/admin/descriptions" aria-current="page"');

		const notFoundRes = await handleAdminRequest(
			adminGet("https://paab.test/admin/nonexistent"),
			devEnv(),
			NOW_MS,
		);
		expect(notFoundRes.status).toBe(404);
		expect(await notFoundRes.text()).toContain("ページが見つかりません");
	});

	it("renders flash banners cleanly and preserves rawHtml when explicitly trusted", () => {
		const page = adminPageResponse({
			title: "詳細",
			currentPath: "/admin",
			user: { email: "owner@example.com", sub: "u1" },
			devMode: false,
			flash: { kind: "error", message: "<script>xss</script>" },
			body: rawHtml("<p>trusted</p>"),
		});
		expect(page.status).toBe(200);
		return page.text().then((text) => {
			expect(text).toContain("&lt;script&gt;xss&lt;/script&gt;");
			expect(text).toContain("<p>trusted</p>");
		});
	});
});

describe("Worker routing via SELF.fetch", () => {
	it("routes /admin through Access fail-closed without affecting /health or /mcp", async () => {
		await createTestDb();

		const adminRes = await SELF.fetch("https://paab.test/admin");
		expect(adminRes.status).toBe(503);

		const adminSlashRes = await SELF.fetch("https://paab.test/admin/");
		expect(adminSlashRes.status).toBe(503);

		const adminSubRes = await SELF.fetch("https://paab.test/admin/agents");
		expect(adminSubRes.status).toBe(503);

		const healthRes = await SELF.fetch("https://paab.test/health");
		expect(healthRes.status).toBe(200);
		expect(await healthRes.text()).toBe("ok");

		const mcpRes = await SELF.fetch("https://paab.test/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(mcpRes.status).toBe(401);
	});
});
