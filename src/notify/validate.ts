const MAX_URL_LENGTH = 2048;
const MAX_SECRET_LENGTH = 2048;
const MAX_HEADER_NAME_LENGTH = 64;
const MIN_STANDARD_WEBHOOKS_KEY_BYTES = 16;

function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function hasNonByteStringChar(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		if (value.charCodeAt(i) > 0xff) {
			return true;
		}
	}
	return false;
}

const FORBIDDEN_HOST_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".home.arpa",
] as const;

const FORBIDDEN_HEADER_NAMES = new Set([
	"host",
	"content-length",
	"content-type",
	"connection",
	"transfer-encoding",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"upgrade",
	"origin",
	"cookie",
	"accept-encoding",
	"user-agent",
]);

const FORBIDDEN_HEADER_PREFIXES = [
	"cf-",
	"x-forwarded-",
	"sec-",
	"proxy-",
] as const;

export interface ValidateWebhookUrlOptions {
	allowInsecureLocalhost?: boolean;
}

export type WebhookUrlValidation =
	| { ok: true; url: string }
	| { ok: false; message: string };

export type CustomHeaderNameValidation =
	| { ok: true; headerName: string }
	| { ok: false; message: string };

export type SecretValidation =
	| { ok: true; secret: string }
	| { ok: false; message: string };

function parseIpv4(
	host: string,
): readonly [number, number, number, number] | null {
	const parts = host.split(".");
	if (parts.length !== 4) {
		return null;
	}
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) {
			return null;
		}
		const n = Number(part);
		if (n < 0 || n > 255) {
			return null;
		}
		octets.push(n);
	}
	const [a, b, c, d] = octets;
	if (
		a === undefined ||
		b === undefined ||
		c === undefined ||
		d === undefined
	) {
		return null;
	}
	return [a, b, c, d] as const;
}

function isBlockedIpv4(
	octets: readonly [number, number, number, number],
): boolean {
	const [a, b, c] = octets;
	// 0.0.0.0/8 ("this network")
	if (a === 0) return true;
	// 10.0.0.0/8 (RFC 1918 private)
	if (a === 10) return true;
	// 100.64.0.0/10 (RFC 6598 CGNAT / shared address space)
	if (a === 100 && b >= 64 && b <= 127) return true;
	// 127.0.0.0/8 (loopback)
	if (a === 127) return true;
	// 169.254.0.0/16 (RFC 3927 link-local, incl. cloud metadata)
	if (a === 169 && b === 254) return true;
	// 172.16.0.0/12 (RFC 1918 private)
	if (a === 172 && b >= 16 && b <= 31) return true;
	// 192.0.0.0/24 (IETF protocol assignments)
	if (a === 192 && b === 0 && c === 0) return true;
	// 192.0.2.0/24 (TEST-NET-1 documentation)
	if (a === 192 && b === 0 && c === 2) return true;
	// 192.88.99.0/24 (6to4 relay anycast, deprecated/reserved)
	if (a === 192 && b === 88 && c === 99) return true;
	// 192.168.0.0/16 (RFC 1918 private)
	if (a === 192 && b === 168) return true;
	// 198.18.0.0/15 (RFC 2544 benchmarking)
	if (a === 198 && (b === 18 || b === 19)) return true;
	// 198.51.100.0/24 (TEST-NET-2 documentation)
	if (a === 198 && b === 51 && c === 100) return true;
	// 203.0.113.0/24 (TEST-NET-3 documentation)
	if (a === 203 && b === 0 && c === 113) return true;
	// 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved / broadcast)
	if (a >= 224) return true;
	return false;
}

function parseHextetGroup(group: string): number[] | null {
	if (group.length === 0) {
		return [];
	}
	const parts = group.split(":");
	const out: number[] = [];
	for (const part of parts) {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) {
			return null;
		}
		out.push(Number.parseInt(part, 16));
	}
	return out;
}

function parseIpv6(raw: string): readonly number[] | null {
	if (raw.length === 0 || raw.includes("%")) {
		return null;
	}

	let normalized = raw;
	if (normalized.includes(".")) {
		const lastColon = normalized.lastIndexOf(":");
		if (lastColon === -1) {
			return null;
		}
		const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
		if (ipv4 === null) {
			return null;
		}
		const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
		const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
		normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
	}

	const halves = normalized.split("::");
	if (halves.length > 2) {
		return null;
	}
	if (halves.length === 1) {
		const words = parseHextetGroup(halves[0] ?? "");
		return words !== null && words.length === 8 ? words : null;
	}

	const left = parseHextetGroup(halves[0] ?? "");
	const right = parseHextetGroup(halves[1] ?? "");
	if (left === null || right === null) {
		return null;
	}
	const missing = 8 - left.length - right.length;
	if (missing < 1) {
		return null;
	}
	return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedIpv6(words: readonly number[]): boolean {
	const [h0, h1, h2, h3, h4, h5, h6, h7] = words;
	if (
		h0 === undefined ||
		h1 === undefined ||
		h2 === undefined ||
		h3 === undefined ||
		h4 === undefined ||
		h5 === undefined ||
		h6 === undefined ||
		h7 === undefined
	) {
		return true;
	}

	// IPv4-mapped IPv6 ::ffff:0:0/96 -> inspect embedded IPv4 address.
	if (
		h0 === 0 &&
		h1 === 0 &&
		h2 === 0 &&
		h3 === 0 &&
		h4 === 0 &&
		h5 === 0xffff
	) {
		return isBlockedIpv4([h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff]);
	}

	// Only Global Unicast (2000::/3) is publicly routable; this also blocks
	// ::/128, ::1/128, ::/96, 64:ff9b::/96, 100::/64, fc00::/7 (ULA),
	// fe80::/10 (link-local), fec0::/10 (site-local), ff00::/8 (multicast).
	if ((h0 & 0xe000) !== 0x2000) {
		return true;
	}

	// 2001:db8::/32 (RFC 3849 documentation)
	if (h0 === 0x2001 && h1 === 0x0db8) return true;
	// 2001::/32 (Teredo tunneling)
	if (h0 === 0x2001 && h1 === 0x0000) return true;
	// 2001:2::/48 (RFC 5180 benchmarking)
	if (h0 === 0x2001 && h1 === 0x0002 && h2 === 0x0000) return true;
	// 2001:10::/28 and 2001:20::/28 (ORCHID / ORCHIDv2)
	if (h0 === 0x2001 && ((h1 & 0xfff0) === 0x0010 || (h1 & 0xfff0) === 0x0020)) {
		return true;
	}
	// 2002::/16 (6to4 tunneling, deprecated/SSRF risk)
	if (h0 === 0x2002) return true;
	// 3fff::/20 (RFC 9637 documentation)
	if (h0 === 0x3fff && (h1 & 0xf000) === 0x0000) return true;

	return false;
}

/**
 * Validates a webhook destination URL against SSRF and formatting constraints.
 */
export function validateWebhookUrl(
	raw: string,
	options: ValidateWebhookUrlOptions = {},
): WebhookUrlValidation {
	if (typeof raw !== "string") {
		return { ok: false, message: "呼び出し先 URL は文字列で指定してください" };
	}
	if (hasControlChar(raw)) {
		return {
			ok: false,
			message: "呼び出し先 URL に改行や制御文字は含められません",
		};
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { ok: false, message: "呼び出し先 URL を入力してください" };
	}
	if (trimmed.length > MAX_URL_LENGTH) {
		return {
			ok: false,
			message: `呼び出し先 URL は ${MAX_URL_LENGTH} 文字以内にしてください`,
		};
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, message: "呼び出し先 URL の形式が不正です" };
	}

	if (parsed.href.length > MAX_URL_LENGTH) {
		return {
			ok: false,
			message: `呼び出し先 URL は ${MAX_URL_LENGTH} 文字以内にしてください`,
		};
	}

	if (parsed.username !== "" || parsed.password !== "") {
		return {
			ok: false,
			message: "呼び出し先 URL にユーザー名やパスワードは含められません",
		};
	}

	const allowInsecureLocalhost = options.allowInsecureLocalhost === true;
	const hostname = parsed.hostname.toLowerCase();
	const isExplicitLocalhost =
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]";

	if (parsed.protocol === "http:") {
		if (!allowInsecureLocalhost) {
			return {
				ok: false,
				message: "呼び出し先 URL は https:// のみ指定できます",
			};
		}
		if (!isExplicitLocalhost) {
			return {
				ok: false,
				message:
					"ローカル試験許可時でも http:// は localhost / 127.0.0.1 / [::1] のみ指定できます",
			};
		}
		return { ok: true, url: parsed.href };
	}

	if (parsed.protocol !== "https:") {
		return {
			ok: false,
			message: "呼び出し先 URL は https:// のみ指定できます",
		};
	}

	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		const literal = hostname.slice(1, -1);
		const words = parseIpv6(literal);
		if (words === null) {
			return {
				ok: false,
				message: "呼び出し先 URL の IPv6 アドレスが不正です",
			};
		}
		if (isBlockedIpv6(words)) {
			return {
				ok: false,
				message:
					"ローカル・プライベート・予約済み IPv6 アドレスは呼び出し先に指定できません",
			};
		}
		return { ok: true, url: parsed.href };
	}

	const normalizedHost = hostname.replace(/\.+$/, "");
	if (
		normalizedHost.length === 0 ||
		normalizedHost.startsWith(".") ||
		normalizedHost.includes("..")
	) {
		return { ok: false, message: "呼び出し先 URL のホスト名が不正です" };
	}

	const ipv4 = parseIpv4(normalizedHost);
	if (ipv4 !== null) {
		if (isBlockedIpv4(ipv4)) {
			return {
				ok: false,
				message:
					"ローカル・プライベート・予約済み IPv4 アドレスは呼び出し先に指定できません",
			};
		}
		return { ok: true, url: parsed.href };
	}

	if (
		normalizedHost === "localhost" ||
		FORBIDDEN_HOST_SUFFIXES.some((suffix) => normalizedHost.endsWith(suffix))
	) {
		return {
			ok: false,
			message: "ローカルまたは内部向けホスト名は呼び出し先に指定できません",
		};
	}

	if (!normalizedHost.includes(".")) {
		return {
			ok: false,
			message: "単一ラベルのホスト名は呼び出し先に指定できません",
		};
	}

	return { ok: true, url: parsed.href };
}

/**
 * Validates a custom authentication header name for `custom_header` auth mode.
 */
export function validateCustomHeaderName(
	raw: string,
): CustomHeaderNameValidation {
	if (typeof raw !== "string") {
		return { ok: false, message: "ヘッダー名は文字列で指定してください" };
	}
	if (hasControlChar(raw)) {
		return { ok: false, message: "ヘッダー名に改行や制御文字は使えません" };
	}
	const headerName = raw.trim();
	if (headerName.length === 0 || headerName.length > MAX_HEADER_NAME_LENGTH) {
		return {
			ok: false,
			message: `ヘッダー名は 1〜${MAX_HEADER_NAME_LENGTH} 文字で指定してください`,
		};
	}
	if (!HEADER_NAME_PATTERN.test(headerName)) {
		return {
			ok: false,
			message: "ヘッダー名は英数字とハイフン（-）のみ使用できます",
		};
	}
	const lower = headerName.toLowerCase();
	if (
		FORBIDDEN_HEADER_NAMES.has(lower) ||
		FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
	) {
		return {
			ok: false,
			message: `ヘッダー名「${headerName}」は予約されているため指定できません`,
		};
	}
	return { ok: true, headerName };
}

/**
 * Decodes a Standard Webhooks `whsec_<base64>` secret into raw key bytes.
 * Returns `null` if the prefix, Base64 syntax, or decoded length (< 16 bytes)
 * is invalid.
 */
export function decodeStandardWebhooksKey(
	secret: string,
): Uint8Array<ArrayBuffer> | null {
	if (
		typeof secret !== "string" ||
		secret.length > MAX_SECRET_LENGTH ||
		!secret.startsWith("whsec_")
	) {
		return null;
	}
	const suffix = secret.slice("whsec_".length);
	if (suffix.length === 0 || suffix.length % 4 === 1) {
		return null;
	}
	if (!BASE64_PATTERN.test(suffix)) {
		return null;
	}
	if (suffix.includes("=") && suffix.length % 4 !== 0) {
		return null;
	}
	let binary: string;
	try {
		binary = atob(suffix);
	} catch {
		return null;
	}
	if (binary.length < MIN_STANDARD_WEBHOOKS_KEY_BYTES) {
		return null;
	}
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/** Validates a Standard Webhooks secret (`whsec_<base64>`, >= 16 decoded bytes). */
export function validateStandardWebhooksSecret(raw: string): SecretValidation {
	if (typeof raw !== "string" || raw.length === 0) {
		return {
			ok: false,
			message:
				"Standard Webhooks のシークレット（whsec_...）を入力してください",
		};
	}
	if (hasControlChar(raw)) {
		return {
			ok: false,
			message: "シークレットに改行や制御文字は含められません",
		};
	}
	if (raw.length > MAX_SECRET_LENGTH) {
		return {
			ok: false,
			message: `シークレットは ${MAX_SECRET_LENGTH} 文字以内にしてください`,
		};
	}
	if (!raw.startsWith("whsec_")) {
		return {
			ok: false,
			message:
				"Standard Webhooks のシークレットは whsec_ で始まる必要があります",
		};
	}
	if (decodeStandardWebhooksKey(raw) === null) {
		return {
			ok: false,
			message:
				"Standard Webhooks のシークレットは whsec_ に続く有効な Base64（デコード後 16 バイト以上）である必要があります",
		};
	}
	return { ok: true, secret: raw };
}

/** Validates an externally issued secret for `bearer_header` or `custom_header`. */
export function validateExternalSecret(raw: string): SecretValidation {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return {
			ok: false,
			message: "認証シークレットを入力してください",
		};
	}
	if (raw.length > MAX_SECRET_LENGTH) {
		return {
			ok: false,
			message: `認証シークレットは ${MAX_SECRET_LENGTH} 文字以内にしてください`,
		};
	}
	if (hasControlChar(raw)) {
		return {
			ok: false,
			message: "認証シークレットに改行や制御文字は含められません",
		};
	}
	if (raw !== raw.trim()) {
		return {
			ok: false,
			message: "認証シークレットの前後に空白は含められません",
		};
	}
	if (hasNonByteStringChar(raw)) {
		return {
			ok: false,
			message:
				"認証シークレットは HTTP ヘッダーに使える文字のみで入力してください",
		};
	}
	return { ok: true, secret: raw };
}

/** Generates a 256-bit random `paab_whsec_<64 hex>` secret for `paab_hmac`. */
export function generatePaabWebhookSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return `paab_whsec_${hex}`;
}
