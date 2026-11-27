import type { UnixMillis, WebhookAuthConfig } from "../types";
import { decodeStandardWebhooksKey } from "./validate";

/** Fixed bodyless wake payload; never includes message content or metadata. */
export const WAKE_PAYLOAD = '{"event":"inbox_wake"}';

function toArrayBufferBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(new ArrayBuffer(input.byteLength));
	copy.set(input);
	return copy;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

async function hmacSha256(
	keyBytes: Uint8Array<ArrayBuffer>,
	message: string,
): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const payload = toArrayBufferBytes(new TextEncoder().encode(message));
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, payload);
	return new Uint8Array(signature);
}

/**
 * Builds the outbound HTTP headers for one webhook delivery attempt according
 * to the configured `auth_mode`.
 */
export async function buildWebhookHeaders(
	webhook: WebhookAuthConfig,
	deliveryId: string,
	now: UnixMillis,
	body = WAKE_PAYLOAD,
): Promise<Headers> {
	const headers = new Headers({
		"Content-Type": "application/json",
	});
	const timestamp = String(Math.floor(now / 1000));

	switch (webhook.authMode) {
		case "standard_webhooks": {
			const keyBytes = decodeStandardWebhooksKey(webhook.secret);
			if (keyBytes === null) {
				throw new Error("Invalid standard_webhooks secret");
			}
			const digest = await hmacSha256(
				keyBytes,
				`${deliveryId}.${timestamp}.${body}`,
			);
			headers.set("webhook-id", deliveryId);
			headers.set("webhook-timestamp", timestamp);
			headers.set("webhook-signature", `v1,${bytesToBase64(digest)}`);
			return headers;
		}
		case "bearer_header": {
			headers.set("Authorization", `Bearer ${webhook.secret}`);
			return headers;
		}
		case "custom_header": {
			headers.set(webhook.headerName, webhook.secret);
			return headers;
		}
		case "paab_hmac": {
			const keyBytes = toArrayBufferBytes(
				new TextEncoder().encode(webhook.secret),
			);
			const digest = await hmacSha256(keyBytes, `${timestamp}.${body}`);
			headers.set("X-Paab-Timestamp", timestamp);
			headers.set("X-Paab-Signature", `sha256=${bytesToHex(digest)}`);
			return headers;
		}
	}
}
