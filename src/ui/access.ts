import type { McpEnv } from "../mcp/config";
import type { UnixMillis } from "../types";

export interface UiEnv extends McpEnv {
	CF_ACCESS_TEAM_DOMAIN?: string;
	CF_ACCESS_AUD?: string;
	ADMIN_DEV_USER?: string;
}

export interface AccessUser {
	email: string;
	sub: string;
}

export type AccessResult =
	| {
			ok: true;
			user: AccessUser;
			devMode: boolean;
	  }
	| {
			ok: false;
			status: 403 | 503;
			message: string;
	  };

export interface JwkKey extends JsonWebKey {
	kid?: string;
	alg?: string;
	use?: string;
}

export interface JwksDocument {
	keys: readonly JwkKey[];
}

export type JwksFetcher = (jwksUrl: string) => Promise<unknown>;

export interface VerifyAccessOptions {
	fetchJwks?: JwksFetcher;
}

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HOSTNAME_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const TEAM_DOMAIN_PATTERN = new RegExp(
	`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*\\.(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$`,
	"i",
);

interface CachedJwks {
	fetchedAt: UnixMillis;
	keysByKid: Map<string, CryptoKey>;
}

// Key cache per fetcher function so custom test fetchers stay isolated without disabling cache tests.
const jwksCacheByFetcher = new WeakMap<JwksFetcher, Map<string, CachedJwks>>();

async function defaultFetchJwks(jwksUrl: string): Promise<unknown> {
	const response = await fetch(jwksUrl, {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`JWKS fetch failed with status ${response.status}`);
	}
	return response.json();
}

export function clearJwksCache(): void {
	jwksCacheByFetcher.delete(defaultFetchJwks);
}

export function normalizeTeamDomain(raw: string): string | null {
	let value = raw.trim();
	if (value.length === 0) {
		return null;
	}
	if (/^https:\/\//i.test(value)) {
		value = value.slice("https://".length);
	} else if (value.includes("://")) {
		return null;
	}
	if (value.endsWith("/")) {
		value = value.slice(0, -1);
	}
	if (value.length === 0 || /[/?#@:\s]/.test(value)) {
		return null;
	}
	if (!TEAM_DOMAIN_PATTERN.test(value)) {
		return null;
	}
	try {
		const url = new URL(`https://${value}`);
		if (
			url.username !== "" ||
			url.password !== "" ||
			url.port !== "" ||
			url.pathname !== "/" ||
			url.search !== "" ||
			url.hash !== "" ||
			url.hostname !== value.toLowerCase()
		) {
			return null;
		}
		return url.hostname;
	} catch {
		return null;
	}
}

function decodeBase64Url(segment: string): Uint8Array<ArrayBuffer> | null {
	if (!BASE64URL_PATTERN.test(segment) || segment.length % 4 === 1) {
		return null;
	}
	const padded = segment
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(segment.length / 4) * 4, "=");
	try {
		const binary = atob(padded);
		const bytes = new Uint8Array(new ArrayBuffer(binary.length));
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(
	bytes: Uint8Array<ArrayBuffer>,
): Record<string, unknown> | null {
	try {
		const text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false,
		}).decode(bytes);
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

interface ParsedAccessJwt {
	kid: string;
	signingInput: Uint8Array<ArrayBuffer>;
	signature: Uint8Array<ArrayBuffer>;
	exp: number;
	nbf: number | undefined;
	aud: string | readonly string[];
	user: AccessUser;
}

function parseAccessJwt(token: string): ParsedAccessJwt | null {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return null;
	}
	const [headerB64, payloadB64, signatureB64] = parts;
	if (!headerB64 || !payloadB64 || !signatureB64) {
		return null;
	}
	const headerBytes = decodeBase64Url(headerB64);
	const payloadBytes = decodeBase64Url(payloadB64);
	const signature = decodeBase64Url(signatureB64);
	if (headerBytes === null || payloadBytes === null || signature === null) {
		return null;
	}

	const header = parseJsonObject(headerBytes);
	const payload = parseJsonObject(payloadBytes);
	if (header === null || payload === null) {
		return null;
	}

	if (header.alg !== "RS256") {
		return null;
	}
	if (
		header.typ !== undefined &&
		(typeof header.typ !== "string" || header.typ.toUpperCase() !== "JWT")
	) {
		return null;
	}
	if (typeof header.kid !== "string" || header.kid.trim().length === 0) {
		return null;
	}

	if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
		return null;
	}
	if (
		payload.nbf !== undefined &&
		(typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf))
	) {
		return null;
	}

	let aud: string | readonly string[];
	if (typeof payload.aud === "string") {
		aud = payload.aud;
	} else if (
		Array.isArray(payload.aud) &&
		payload.aud.every((item): item is string => typeof item === "string")
	) {
		aud = payload.aud;
	} else {
		return null;
	}

	if (typeof payload.email !== "string" || payload.email.trim().length === 0) {
		return null;
	}
	if (payload.sub !== undefined && typeof payload.sub !== "string") {
		return null;
	}

	const email = payload.email.trim();
	const sub =
		typeof payload.sub === "string" && payload.sub.trim().length > 0
			? payload.sub.trim()
			: email;

	const encoded = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signingInput = new Uint8Array(new ArrayBuffer(encoded.byteLength));
	signingInput.set(encoded);

	return {
		kid: header.kid,
		signingInput,
		signature,
		exp: payload.exp,
		nbf: payload.nbf,
		aud,
		user: { email, sub },
	};
}

function getFetcherCache(fetcher: JwksFetcher): Map<string, CachedJwks> {
	let cache = jwksCacheByFetcher.get(fetcher);
	if (cache === undefined) {
		cache = new Map();
		jwksCacheByFetcher.set(fetcher, cache);
	}
	return cache;
}

async function importJwks(
	rawDocument: unknown,
): Promise<Map<string, CryptoKey> | null> {
	if (!isRecord(rawDocument) || !Array.isArray(rawDocument.keys)) {
		return null;
	}
	const keysByKid = new Map<string, CryptoKey>();
	for (const entry of rawDocument.keys) {
		if (!isRecord(entry)) {
			continue;
		}
		if (typeof entry.kid !== "string" || entry.kid.length === 0) {
			continue;
		}
		if (entry.kty !== "RSA") {
			continue;
		}
		if (typeof entry.n !== "string" || typeof entry.e !== "string") {
			continue;
		}
		if (entry.alg !== undefined && entry.alg !== "RS256") {
			continue;
		}
		if (entry.use !== undefined && entry.use !== "sig") {
			continue;
		}
		const jwk: JsonWebKey = {
			kty: "RSA",
			n: entry.n,
			e: entry.e,
			...(typeof entry.alg === "string" ? { alg: entry.alg } : {}),
			...(typeof entry.use === "string" ? { use: entry.use } : {}),
		};
		try {
			const cryptoKey = await crypto.subtle.importKey(
				"jwk",
				jwk,
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"],
			);
			keysByKid.set(entry.kid, cryptoKey);
		} catch {
			// Skip malformed or unsupported keys so other valid keys in the set still load.
		}
	}
	return keysByKid;
}

async function resolvePublicKey(
	jwksUrl: string,
	kid: string,
	now: UnixMillis,
	fetcher: JwksFetcher,
): Promise<{ ok: true; key: CryptoKey | null } | { ok: false }> {
	const cache = getFetcherCache(fetcher);
	const cached = cache.get(jwksUrl);
	if (cached !== undefined && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
		const hit = cached.keysByKid.get(kid);
		if (hit !== undefined) {
			return { ok: true, key: hit };
		}
	}

	let keysByKid: Map<string, CryptoKey> | null;
	try {
		const raw = await fetcher(jwksUrl);
		keysByKid = await importJwks(raw);
	} catch {
		return { ok: false };
	}
	if (keysByKid === null) {
		return { ok: false };
	}

	cache.set(jwksUrl, { fetchedAt: now, keysByKid });
	return { ok: true, key: keysByKid.get(kid) ?? null };
}

/**
 * Verifies Cloudflare Access authentication for an incoming `/admin` request.
 *
 * Fails closed when Access configuration is missing (`503`) or partial (`503`),
 * and only permits `ADMIN_DEV_USER` when both Access variables are unset.
 */
export async function verifyAccessRequest(
	request: Request,
	env: UiEnv,
	now: UnixMillis,
	options: VerifyAccessOptions = {},
): Promise<AccessResult> {
	const teamDomainRaw = env.CF_ACCESS_TEAM_DOMAIN?.trim() ?? "";
	const aud = env.CF_ACCESS_AUD?.trim() ?? "";
	const devUser = env.ADMIN_DEV_USER?.trim() ?? "";

	const hasDomain = teamDomainRaw.length > 0;
	const hasAud = aud.length > 0;

	if (hasDomain !== hasAud) {
		return {
			ok: false,
			status: 503,
			message:
				"Cloudflare Access の設定が不完全です（CF_ACCESS_TEAM_DOMAIN と CF_ACCESS_AUD の両方が必要です）",
		};
	}

	if (!hasDomain && !hasAud) {
		if (devUser.length > 0) {
			return {
				ok: true,
				user: { email: devUser, sub: "dev" },
				devMode: true,
			};
		}
		return {
			ok: false,
			status: 503,
			message: "Cloudflare Access が設定されていません",
		};
	}

	const teamDomain = normalizeTeamDomain(teamDomainRaw);
	if (teamDomain === null) {
		return {
			ok: false,
			status: 503,
			message: "CF_ACCESS_TEAM_DOMAIN の形式が不正です",
		};
	}

	const jwtAssertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
	if (!jwtAssertion) {
		return {
			ok: false,
			status: 403,
			message: "Cloudflare Access 認証ヘッダーがありません",
		};
	}

	const parsed = parseAccessJwt(jwtAssertion);
	if (parsed === null) {
		return {
			ok: false,
			status: 403,
			message: "Cloudflare Access トークンの形式が不正です",
		};
	}

	const nowSec = Math.floor(now / 1000);
	if (!(nowSec < parsed.exp)) {
		return {
			ok: false,
			status: 403,
			message: "Cloudflare Access トークンの有効期限が切れています",
		};
	}
	if (parsed.nbf !== undefined && !(nowSec >= parsed.nbf)) {
		return {
			ok: false,
			status: 403,
			message: "Cloudflare Access トークンはまだ有効ではありません",
		};
	}

	const audMatches =
		typeof parsed.aud === "string"
			? parsed.aud === aud
			: parsed.aud.includes(aud);
	if (!audMatches) {
		return {
			ok: false,
			status: 403,
			message: "Cloudflare Access トークンの対象アプリケーションが一致しません",
		};
	}

	const jwksUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
	const fetcher = options.fetchJwks ?? defaultFetchJwks;
	const resolved = await resolvePublicKey(jwksUrl, parsed.kid, now, fetcher);
	if (!resolved.ok) {
		return {
			ok: false,
			status: 503,
			message: "Cloudflare Access の公開鍵を取得できませんでした",
		};
	}
	if (resolved.key === null) {
		return {
			ok: false,
			status: 403,
			message: "Cloudflare Access トークンの署名鍵が見つかりません",
		};
	}

	const verified = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		resolved.key,
		parsed.signature,
		parsed.signingInput,
	);
	if (!verified) {
		return {
			ok: false,
			status: 403,
			message: "Cloudflare Access トークンの署名が正しくありません",
		};
	}

	return {
		ok: true,
		user: parsed.user,
		devMode: false,
	};
}
