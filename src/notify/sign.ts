export const WEBHOOK_BODY = '{"event":"inbox_wake"}';

const SECRET_PREFIX = "paab_whsec_";
const SECRET_RANDOM_BYTES = 32;

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

/** Generates a 256-bit random HMAC signing secret for a webhook endpoint. */
export function generateWebhookSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(SECRET_RANDOM_BYTES));
	return SECRET_PREFIX + toBase64Url(bytes);
}

/**
 * Signs `${timestampSeconds}.${body}` with HMAC-SHA256 and returns
 * `sha256=<lowercase hex>`.
 */
export async function signWebhookPayload(
	signingSecret: string,
	timestampSeconds: string,
	body: string = WEBHOOK_BODY,
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(signingSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`${timestampSeconds}.${body}`),
	);
	let hex = "";
	for (const byte of new Uint8Array(signature)) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return `sha256=${hex}`;
}
