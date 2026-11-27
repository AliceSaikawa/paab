import { describe, expect, it } from "vitest";
import { buildWebhookHeaders, WAKE_PAYLOAD } from "../../src/notify";

const NOW = Date.UTC(2026, 10, 27, 12, 34, 56, 789);
const EXPECTED_TS = String(Math.floor(NOW / 1000));
const DELIVERY_ID = "01234567-89ab-4cde-8f01-23456789abcd";

async function referenceHmacSha256(
	keyBytes: Uint8Array,
	message: string,
): Promise<Uint8Array> {
	const keyCopy = new Uint8Array(new ArrayBuffer(keyBytes.byteLength));
	keyCopy.set(keyBytes);
	const key = await crypto.subtle.importKey(
		"raw",
		keyCopy,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const msg = new TextEncoder().encode(message);
	const msgCopy = new Uint8Array(new ArrayBuffer(msg.byteLength));
	msgCopy.set(msg);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, msgCopy));
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("buildWebhookHeaders", () => {
	it("fixes WAKE_PAYLOAD to bodyless inbox_wake JSON", () => {
		expect(WAKE_PAYLOAD).toBe('{"event":"inbox_wake"}');
		expect(JSON.parse(WAKE_PAYLOAD)).toEqual({ event: "inbox_wake" });
	});

	it("signs standard_webhooks with base64-decoded whsec_ key over id.ts.body", async () => {
		const rawKey = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
		const secret = `whsec_${toBase64(rawKey)}`;

		const headers = await buildWebhookHeaders(
			{ authMode: "standard_webhooks", secret },
			DELIVERY_ID,
			NOW,
		);

		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("webhook-id")).toBe(DELIVERY_ID);
		expect(headers.get("webhook-timestamp")).toBe(EXPECTED_TS);
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("x-paab-signature")).toBeNull();

		const expectedDigest = await referenceHmacSha256(
			rawKey,
			`${DELIVERY_ID}.${EXPECTED_TS}.${WAKE_PAYLOAD}`,
		);
		expect(headers.get("webhook-signature")).toBe(
			`v1,${toBase64(expectedDigest)}`,
		);
	});

	it("builds bearer_header Authorization header", async () => {
		const headers = await buildWebhookHeaders(
			{ authMode: "bearer_header", secret: "manus-secret-token" },
			DELIVERY_ID,
			NOW,
		);

		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("authorization")).toBe("Bearer manus-secret-token");
		expect(headers.get("webhook-signature")).toBeNull();
		expect(headers.get("x-paab-signature")).toBeNull();
	});

	it("builds custom_header with configured header name and secret", async () => {
		const headers = await buildWebhookHeaders(
			{
				authMode: "custom_header",
				headerName: "X-Cue-Trigger-Key",
				secret: "cue-key-999",
			},
			DELIVERY_ID,
			NOW,
		);

		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-cue-trigger-key")).toBe("cue-key-999");
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("webhook-signature")).toBeNull();
		expect(headers.get("x-paab-signature")).toBeNull();
	});

	it("signs paab_hmac with UTF-8 secret bytes over ts.body as sha256=<hex>", async () => {
		const secret = `paab_whsec_${"1a".repeat(32)}`;

		const headers = await buildWebhookHeaders(
			{ authMode: "paab_hmac", secret },
			DELIVERY_ID,
			NOW,
		);

		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-paab-timestamp")).toBe(EXPECTED_TS);
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("webhook-signature")).toBeNull();

		const expectedDigest = await referenceHmacSha256(
			new TextEncoder().encode(secret),
			`${EXPECTED_TS}.${WAKE_PAYLOAD}`,
		);
		expect(headers.get("x-paab-signature")).toBe(
			`sha256=${toHex(expectedDigest)}`,
		);
	});

	it("throws if standard_webhooks secret is invalid", async () => {
		await expect(
			buildWebhookHeaders(
				{ authMode: "standard_webhooks", secret: "bad_secret" },
				DELIVERY_ID,
				NOW,
			),
		).rejects.toThrow(/Invalid standard_webhooks secret/);
	});
});
