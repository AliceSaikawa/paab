import { html, type SafeHtml } from "./html";

export const CSRF_FORM_FIELD = "csrf_token";

const CSRF_TOKEN_BYTES = 32;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_FORM_BYTES = 256 * 1024;

export class FormReadError extends Error {
	constructor(
		readonly status: 400 | 413 | 415,
		message: string,
	) {
		super(message);
		this.name = "FormReadError";
	}
}

export type CsrfFailureReason =
	| "cross_origin"
	| "missing_cookie"
	| "invalid_form"
	| "missing_token"
	| "token_mismatch";

export type CsrfPostResult =
	| { ok: true; token: string; form: URLSearchParams }
	| {
			ok: false;
			status: 400 | 403 | 413 | 415;
			reason: CsrfFailureReason;
			message: string;
	  };

export function csrfCookieName(url: URL): string {
	return url.protocol === "https:" ? "__Host-paab_csrf" : "paab_csrf";
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

export function generateCsrfToken(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(CSRF_TOKEN_BYTES)));
}

export function isValidCsrfToken(value: string): boolean {
	return CSRF_TOKEN_PATTERN.test(value);
}

export function readCsrfCookie(request: Request, url: URL): string | null {
	const header = request.headers.get("Cookie");
	if (header === null) {
		return null;
	}
	const targetName = csrfCookieName(url);
	const matches: string[] = [];
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		const name = part.slice(0, eq).trim();
		if (name !== targetName) {
			continue;
		}
		matches.push(part.slice(eq + 1).trim());
	}
	if (matches.length !== 1) {
		return null;
	}
	const value = matches[0] ?? "";
	return isValidCsrfToken(value) ? value : null;
}

export function createCsrfSetCookie(url: URL, token: string): string {
	const name = csrfCookieName(url);
	if (url.protocol === "https:") {
		// Browsers reject `__Host-` cookies unless `Path=/` and `Secure` are both set without `Domain`.
		return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure`;
	}
	return `${name}=${token}; Path=/admin; HttpOnly; SameSite=Lax`;
}

function tokensEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	return crypto.subtle.timingSafeEqual(left, right);
}

function isSameOrigin(headerValue: string, expectedOrigin: string): boolean {
	try {
		return new URL(headerValue).origin === expectedOrigin;
	} catch {
		return false;
	}
}

/** Reads an `application/x-www-form-urlencoded` request body with a size bound. */
export async function readForm(request: Request): Promise<URLSearchParams> {
	const contentType = request.headers.get("Content-Type");
	if (contentType !== null) {
		const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		if (mediaType !== "application/x-www-form-urlencoded") {
			throw new FormReadError(
				415,
				"Content-Type は application/x-www-form-urlencoded である必要があります",
			);
		}
	}
	// Read raw bytes instead of `request.text()` so workerd does not warn on `application/x-www-form-urlencoded`.
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > MAX_FORM_BYTES) {
		throw new FormReadError(413, "フォームデータが大きすぎます");
	}
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false,
		}).decode(bytes);
	} catch {
		throw new FormReadError(400, "フォームデータの文字コードが不正です");
	}
	return new URLSearchParams(raw);
}

/** Ensures a `GET` request has a CSRF token, reusing a valid cookie or minting one. */
export function prepareCsrfGet(
	request: Request,
	url: URL,
): { token: string; setCookie: string | null } {
	const existing = readCsrfCookie(request, url);
	if (existing !== null) {
		return { token: existing, setCookie: null };
	}
	const token = generateCsrfToken();
	return { token, setCookie: createCsrfSetCookie(url, token) };
}

/** Validates origin headers, CSRF cookie, and form `csrf_token` on a `POST` request. */
export async function verifyCsrfPost(
	request: Request,
	url: URL,
): Promise<CsrfPostResult> {
	const origin = request.headers.get("Origin");
	if (origin !== null && !isSameOrigin(origin, url.origin)) {
		return {
			ok: false,
			status: 403,
			reason: "cross_origin",
			message: "クロスオリジンからの送信は許可されていません",
		};
	}

	const referer = request.headers.get("Referer");
	if (referer !== null && !isSameOrigin(referer, url.origin)) {
		return {
			ok: false,
			status: 403,
			reason: "cross_origin",
			message: "不正な送信元からのリクエストです",
		};
	}

	const cookieToken = readCsrfCookie(request, url);
	if (cookieToken === null) {
		return {
			ok: false,
			status: 403,
			reason: "missing_cookie",
			message: "CSRF クッキーがありません。画面を再読み込みしてください",
		};
	}

	let form: URLSearchParams;
	try {
		form = await readForm(request);
	} catch (error) {
		if (error instanceof FormReadError) {
			return {
				ok: false,
				status: error.status,
				reason: "invalid_form",
				message: error.message,
			};
		}
		throw error;
	}

	const formToken = form.get(CSRF_FORM_FIELD);
	if (formToken === null || !isValidCsrfToken(formToken)) {
		return {
			ok: false,
			status: 403,
			reason: "missing_token",
			message: "CSRF トークンが一致しません。画面を再読み込みしてください",
		};
	}
	if (!tokensEqual(cookieToken, formToken)) {
		return {
			ok: false,
			status: 403,
			reason: "token_mismatch",
			message: "CSRF トークンが一致しません。画面を再読み込みしてください",
		};
	}

	return { ok: true, token: cookieToken, form };
}

export function rotateCsrfCookie(response: Response, url: URL): Response {
	const headers = new Headers(response.headers);
	headers.append("Set-Cookie", createCsrfSetCookie(url, generateCsrfToken()));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Renders the hidden CSRF input field for admin POST forms. */
export function csrfInput(token: string): SafeHtml {
	return html`<input type="hidden" name="${CSRF_FORM_FIELD}" value="${token}">`;
}
