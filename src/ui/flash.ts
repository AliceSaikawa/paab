import type { FlashMessage } from "./layout";

export const FLASH_COOKIE_NAME = "paab_flash";

const FLASH_MAX_AGE_SECONDS = 60;
const MAX_FLASH_COOKIE_BYTES = 3072;
const MAX_FLASH_MESSAGE_LENGTH = 500;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type FlashKind = FlashMessage["kind"];

export interface StoredFlash {
	kind: FlashKind;
	message: string;
}

const VALID_FLASH_KINDS: ReadonlySet<string> = new Set<FlashKind>([
	"info",
	"success",
	"warning",
	"error",
]);

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function decodeBase64Url(encoded: string): Uint8Array | null {
	if (
		encoded.length === 0 ||
		encoded.length > MAX_FLASH_COOKIE_BYTES ||
		encoded.length % 4 === 1 ||
		!BASE64URL_PATTERN.test(encoded)
	) {
		return null;
	}
	const paddedLength = encoded.length + ((4 - (encoded.length % 4)) % 4);
	const standard = encoded
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(paddedLength, "=");
	let binary: string;
	try {
		binary = atob(standard);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function encodeFlashValue(flash: StoredFlash): string {
	const payload = JSON.stringify({
		kind: flash.kind,
		message: flash.message.slice(0, MAX_FLASH_MESSAGE_LENGTH),
	});
	return encodeBase64Url(new TextEncoder().encode(payload));
}

export function decodeFlashValue(raw: string): StoredFlash | null {
	const bytes = decodeBase64Url(raw);
	if (bytes === null) {
		return null;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false,
		}).decode(bytes);
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const record = parsed as Record<string, unknown>;
	const kind = record.kind;
	const message = record.message;
	if (
		typeof kind !== "string" ||
		!VALID_FLASH_KINDS.has(kind) ||
		typeof message !== "string" ||
		message.length === 0 ||
		message.length > MAX_FLASH_MESSAGE_LENGTH
	) {
		return null;
	}
	return { kind: kind as FlashKind, message };
}

function flashCookieAttributes(url: URL, maxAge: number): string {
	const secure = url.protocol === "https:" ? "; Secure" : "";
	return `Path=/admin; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function createFlashSetCookie(url: URL, flash: StoredFlash): string {
	return `${FLASH_COOKIE_NAME}=${encodeFlashValue(flash)}; ${flashCookieAttributes(url, FLASH_MAX_AGE_SECONDS)}`;
}

export function clearFlashSetCookie(url: URL): string {
	return `${FLASH_COOKIE_NAME}=; ${flashCookieAttributes(url, 0)}`;
}

export function readFlashCookie(request: Request): {
	flash: StoredFlash | null;
	hasCookie: boolean;
} {
	const header = request.headers.get("Cookie");
	if (header === null) {
		return { flash: null, hasCookie: false };
	}
	const matches: string[] = [];
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		const name = part.slice(0, eq).trim();
		if (name !== FLASH_COOKIE_NAME) {
			continue;
		}
		matches.push(part.slice(eq + 1).trim());
	}
	if (matches.length === 0) {
		return { flash: null, hasCookie: false };
	}
	if (matches.length !== 1) {
		return { flash: null, hasCookie: true };
	}
	return {
		flash: decodeFlashValue(matches[0] ?? ""),
		hasCookie: true,
	};
}

export function adminRedirectResponse(
	location: string,
	url: URL,
	flash?: StoredFlash,
): Response {
	if (location !== "/admin" && !location.startsWith("/admin/")) {
		throw new Error(`Invalid admin redirect target: ${location}`);
	}
	const headers = new Headers({
		Location: location,
		"Cache-Control": "no-store",
		"Referrer-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	});
	if (flash !== undefined) {
		headers.append("Set-Cookie", createFlashSetCookie(url, flash));
	}
	return new Response(null, { status: 303, headers });
}
