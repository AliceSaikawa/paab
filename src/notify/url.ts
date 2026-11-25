import type { NotifyEnv, WebhookUrlValidation } from "./types";

const MAX_WEBHOOK_URL_LENGTH = 2048;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET_PATTERN = /^[0-9a-f]{1,4}$/i;

export function isLocalWebhookAllowed(
	env: Pick<NotifyEnv, "ALLOW_LOCAL_WEBHOOKS"> | undefined,
): boolean {
	return env?.ALLOW_LOCAL_WEBHOOKS === "true";
}

function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

function hasAuthorityAt(rawUrl: string): boolean {
	const schemeEnd = rawUrl.indexOf("://");
	if (schemeEnd === -1) return false;
	const afterScheme = rawUrl.slice(schemeEnd + 3);
	const boundary = afterScheme.search(/[/?#]/);
	const authority =
		boundary === -1 ? afterScheme : afterScheme.slice(0, boundary);
	return authority.includes("@");
}

function parseIpv4(host: string): [number, number, number, number] | null {
	const match = IPV4_PATTERN.exec(host);
	if (match === null) return null;
	const octets = [
		Number(match[1]),
		Number(match[2]),
		Number(match[3]),
		Number(match[4]),
	];
	if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return null;
	}
	return octets as [number, number, number, number];
}

function isBlockedIpv4(octets: [number, number, number, number]): boolean {
	const [a, b, c] = octets;
	if (a === 0) return true;
	if (a === 10) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 0 && c === 0) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a >= 224) return true;
	return false;
}

function parseIpv6(rawHost: string): number[] | null {
	if (rawHost.includes("%")) return null;
	let input = rawHost;
	const lastColon = input.lastIndexOf(":");
	let tailIpv4: [number, number, number, number] | null = null;
	if (lastColon !== -1 && input.slice(lastColon + 1).includes(".")) {
		tailIpv4 = parseIpv4(input.slice(lastColon + 1));
		if (tailIpv4 === null) return null;
		input = input.slice(0, lastColon + 1);
	}

	const doubleColonParts = input.split("::");
	if (doubleColonParts.length > 2) return null;

	const parseSide = (part: string): number[] | null => {
		if (part === "") return [];
		const segments = part.split(":");
		const values: number[] = [];
		for (const seg of segments) {
			if (!HEXTET_PATTERN.test(seg)) return null;
			values.push(Number.parseInt(seg, 16));
		}
		return values;
	};

	const left = parseSide(doubleColonParts[0] ?? "");
	const right =
		doubleColonParts.length === 2 ? parseSide(doubleColonParts[1] ?? "") : [];
	if (left === null || right === null) return null;

	const ipv4Groups = tailIpv4
		? [(tailIpv4[0] << 8) | tailIpv4[1], (tailIpv4[2] << 8) | tailIpv4[3]]
		: [];
	const totalExplicit = left.length + right.length + ipv4Groups.length;

	if (doubleColonParts.length === 1) {
		if (totalExplicit !== 8) return null;
		return [...left, ...ipv4Groups];
	}
	if (totalExplicit >= 8) return null;
	const zeros = new Array<number>(8 - totalExplicit).fill(0);
	return [...left, ...zeros, ...right, ...ipv4Groups];
}

function isBlockedIpv6(groups: number[]): boolean {
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];

	const prefixZero96 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
	if (prefixZero96 && g5 === 0) {
		if (g6 === 0 && (g7 === 0 || g7 === 1)) return true;
		return isBlockedIpv4([g6 >>> 8, g6 & 0xff, g7 >>> 8, g7 & 0xff]);
	}
	if (prefixZero96 && g5 === 0xffff) {
		return isBlockedIpv4([g6 >>> 8, g6 & 0xff, g7 >>> 8, g7 & 0xff]);
	}
	if (
		g0 === 0x0064 &&
		g1 === 0xff9b &&
		g2 === 0 &&
		g3 === 0 &&
		g4 === 0 &&
		g5 === 0
	) {
		return isBlockedIpv4([g6 >>> 8, g6 & 0xff, g7 >>> 8, g7 & 0xff]);
	}
	if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) return true;
	if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
	if ((g0 & 0xfe00) === 0xfc00) return true;
	if ((g0 & 0xffc0) === 0xfe80) return true;
	if ((g0 & 0xffc0) === 0xfec0) return true;
	if ((g0 & 0xff00) === 0xff00) return true;
	return false;
}

function isLocalOrPrivateHost(hostname: string): boolean {
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		const groups = parseIpv6(hostname.slice(1, -1));
		return groups === null || isBlockedIpv6(groups);
	}

	const normalized = hostname.replace(/\.+$/, "").toLowerCase();
	if (normalized.length === 0) return true;

	const ipv4 = parseIpv4(normalized);
	if (ipv4 !== null) {
		return isBlockedIpv4(ipv4);
	}

	if (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized === "local" ||
		normalized.endsWith(".local") ||
		normalized === "internal" ||
		normalized.endsWith(".internal") ||
		!normalized.includes(".")
	) {
		return true;
	}
	return false;
}

/**
 * Validates a webhook callback URL for scheme, credentials, and SSRF targets.
 * Local and plaintext targets are permitted only when `allowLocal` is true.
 */
export function validateWebhookUrl(
	rawUrl: string,
	allowLocal = false,
): WebhookUrlValidation {
	if (typeof rawUrl !== "string") {
		return { ok: false, message: "Webhook URL を文字列で指定してください" };
	}
	const trimmed = rawUrl.trim();
	if (trimmed.length === 0) {
		return { ok: false, message: "Webhook URL を入力してください" };
	}
	if (trimmed.length > MAX_WEBHOOK_URL_LENGTH) {
		return {
			ok: false,
			message: `Webhook URL は ${MAX_WEBHOOK_URL_LENGTH} 文字以内で指定してください`,
		};
	}
	if (hasControlChar(trimmed)) {
		return {
			ok: false,
			message: "Webhook URL に制御文字や改行は使えません",
		};
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, message: "Webhook URL の形式が不正です" };
	}

	if (
		parsed.username !== "" ||
		parsed.password !== "" ||
		hasAuthorityAt(trimmed)
	) {
		return {
			ok: false,
			message: "Webhook URL にユーザー名やパスワードを含めることはできません",
		};
	}

	if (allowLocal) {
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return {
				ok: false,
				message: "Webhook URL は https:// または http:// で指定してください",
			};
		}
		if (parsed.hostname.length === 0) {
			return { ok: false, message: "Webhook URL のホスト名が不正です" };
		}
		return { ok: true, url: parsed.href };
	}

	if (parsed.protocol !== "https:") {
		return {
			ok: false,
			message: "Webhook URL は https:// で指定してください",
		};
	}

	if (isLocalOrPrivateHost(parsed.hostname)) {
		return {
			ok: false,
			message:
				"ローカルホスト・内部ドメイン・プライベート IP 宛の Webhook URL は指定できません",
		};
	}

	return { ok: true, url: parsed.href };
}
