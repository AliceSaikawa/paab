import { describe, expect, it } from "vitest";
import {
	decodeStandardWebhooksKey,
	generatePaabWebhookSecret,
	validateCustomHeaderName,
	validateExternalSecret,
	validateStandardWebhooksSecret,
	validateWebhookUrl,
} from "../../src/notify";

describe("validateWebhookUrl", () => {
	it("accepts public HTTPS URLs including paths, queries, ports, and public IPs", () => {
		const valid = [
			"https://hooks.example.com/wake",
			"https://api.x.ai:8443/v1/webhooks/abc?token=ignored",
			"https://93.184.216.34/webhook",
			"https://[2606:4700:4700::1111]/webhook",
			"https://[::ffff:93.184.216.34]/webhook",
		];
		for (const raw of valid) {
			const result = validateWebhookUrl(raw);
			expect(result.ok, raw).toBe(true);
		}
	});

	it("rejects non-HTTPS schemes, empty input, control chars, userinfo, and overly long URLs", () => {
		const invalid = [
			"",
			"   ",
			"not-a-url",
			"http://hooks.example.com/wake",
			"ftp://hooks.example.com/wake",
			"javascript:alert(1)",
			"file:///etc/passwd",
			"https://user:pass@hooks.example.com/wake",
			"https://user@hooks.example.com/wake",
			"https://hooks.example.com/wake\nX-Injected: 1",
			"https://hooks.example.com/wake\r\n",
			"https://hooks.example.com/wake\t",
			"https://hooks.example.com/wake\0",
			`https://hooks.example.com/${"a".repeat(2040)}`,
		];
		for (const raw of invalid) {
			const result = validateWebhookUrl(raw);
			expect(result.ok, raw).toBe(false);
		}
	});

	it("rejects localhost, internal suffixes, leading-dot, and single-label hostnames", () => {
		const invalid = [
			"https://localhost/wake",
			"https://localhost./wake",
			"https://sub.localhost/wake",
			"https://printer.local/wake",
			"https://service.internal/wake",
			"https://router.home.arpa/wake",
			"https://intranet/wake",
			"https://metadata/computeMetadata/v1/",
			"https://.example.com/hook",
			"https://..example.com/hook",
		];
		for (const raw of invalid) {
			const result = validateWebhookUrl(raw);
			expect(result.ok, raw).toBe(false);
		}
	});

	it("rejects private, loopback, link-local, CGNAT, doc, multicast, reserved, and obfuscated IPv4 literals", () => {
		const invalid = [
			"https://0.0.0.0/wake",
			"https://10.0.0.1/wake",
			"https://100.64.0.1/wake",
			"https://100.127.255.254/wake",
			"https://127.0.0.1/wake",
			"https://127.0.0.2/wake",
			"https://127.0.0.1./wake",
			"https://169.254.169.254/latest/meta-data/",
			"https://172.16.0.1/wake",
			"https://172.31.255.255/wake",
			"https://192.0.0.1/wake",
			"https://192.0.2.1/wake",
			"https://192.88.99.1/wake",
			"https://192.168.1.1/wake",
			"https://198.18.0.1/wake",
			"https://198.51.100.1/wake",
			"https://203.0.113.1/wake",
			"https://224.0.0.1/wake",
			"https://240.0.0.1/wake",
			"https://255.255.255.255/wake",
			// Obfuscated forms canonicalized by WHATWG URL
			"https://2130706433/wake",
			"https://0x7f000001/wake",
			"https://127.1/wake",
			"https://0177.0.0.1/wake",
		];
		for (const raw of invalid) {
			const result = validateWebhookUrl(raw);
			expect(result.ok, raw).toBe(false);
		}
	});

	it("rejects blocked IPv6 literals and IPv4-mapped IPv6 targeting blocked IPv4 ranges", () => {
		const invalid = [
			"https://[::]/wake",
			"https://[::1]/wake",
			"https://[fc00::1]/wake",
			"https://[fd12:3456:789a::1]/wake",
			"https://[fe80::1]/wake",
			"https://[fec0::1]/wake",
			"https://[ff02::1]/wake",
			"https://[100::1]/wake",
			"https://[2001:db8::1]/wake",
			"https://[2001::1]/wake",
			"https://[2001:2::1]/wake",
			"https://[2001:10::1]/wake",
			"https://[2001:20::1]/wake",
			"https://[2002:7f00:1::1]/wake",
			"https://[3fff::1]/wake",
			"https://[64:ff9b::127.0.0.1]/wake",
			// IPv4-mapped IPv6 (dotted-quad and hex)
			"https://[::ffff:127.0.0.1]/wake",
			"https://[::ffff:7f00:1]/wake",
			"https://[::ffff:10.0.0.1]/wake",
			"https://[::ffff:169.254.169.254]/wake",
			"https://[::ffff:172.16.0.1]/wake",
			"https://[::ffff:192.168.1.1]/wake",
			"https://[::ffff:100.64.0.1]/wake",
			"https://[::ffff:0.0.0.0]/wake",
		];
		for (const raw of invalid) {
			const result = validateWebhookUrl(raw);
			expect(result.ok, raw).toBe(false);
		}
	});

	it("allows insecure HTTP localhost only when allowInsecureLocalhost is explicitly enabled", () => {
		const localUrls = [
			"http://localhost:8788/wake",
			"http://127.0.0.1:8788/wake",
			"http://[::1]:8788/wake",
		];
		for (const raw of localUrls) {
			expect(validateWebhookUrl(raw).ok, `default ${raw}`).toBe(false);
			expect(
				validateWebhookUrl(raw, { allowInsecureLocalhost: true }).ok,
				`opt-in ${raw}`,
			).toBe(true);
		}

		// Opt-in must NOT allow other HTTP hosts or private ranges.
		const stillRejected = [
			"http://hooks.example.com/wake",
			"http://127.0.0.2:8788/wake",
			"http://10.0.0.1:8788/wake",
			"http://192.168.1.1/wake",
			"http://sub.localhost:8788/wake",
			"https://10.0.0.1/wake",
			"https://169.254.169.254/wake",
		];
		for (const raw of stillRejected) {
			expect(
				validateWebhookUrl(raw, { allowInsecureLocalhost: true }).ok,
				raw,
			).toBe(false);
		}
	});
});

describe("validateCustomHeaderName", () => {
	it("accepts valid alphanumeric/hyphen header names", () => {
		expect(validateCustomHeaderName("X-Webhook-Token")).toEqual({
			ok: true,
			headerName: "X-Webhook-Token",
		});
		expect(validateCustomHeaderName("X-API-Key-2")).toEqual({
			ok: true,
			headerName: "X-API-Key-2",
		});
		expect(validateCustomHeaderName("Authorization")).toEqual({
			ok: true,
			headerName: "Authorization",
		});
	});

	it("rejects malformed names, reserved headers, and reserved prefixes", () => {
		const invalid = [
			"",
			"   ",
			"a".repeat(65),
			"X_Underscore",
			"X-Space Header",
			"X-Colon:Value",
			"X-CrLf\r\n",
			"Host",
			"content-length",
			"Content-Type",
			"Connection",
			"Transfer-Encoding",
			"Keep-Alive",
			"Proxy-Authorization",
			"Proxy-Connection",
			"TE",
			"Trailer",
			"Upgrade",
			"Origin",
			"Cookie",
			"Accept-Encoding",
			"User-Agent",
			"CF-Connecting-IP",
			"cf-ray",
			"X-Forwarded-For",
			"x-forwarded-proto",
			"Sec-Fetch-Site",
			"Proxy-Custom-Header",
		];
		for (const raw of invalid) {
			expect(validateCustomHeaderName(raw).ok, raw).toBe(false);
		}
	});
});

describe("webhook secrets validation and generation", () => {
	it("validates and decodes Standard Webhooks whsec_ keys (>= 16 bytes)", () => {
		// 16 bytes: "0123456789abcdef"
		const valid16 = `whsec_${btoa("0123456789abcdef")}`;
		expect(validateStandardWebhooksSecret(valid16)).toEqual({
			ok: true,
			secret: valid16,
		});
		const decoded = decodeStandardWebhooksKey(valid16);
		expect(decoded).not.toBeNull();
		expect(decoded?.byteLength).toBe(16);
		expect(new TextDecoder().decode(decoded as Uint8Array)).toBe(
			"0123456789abcdef",
		);

		// 32 bytes
		const valid32 = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
		expect(validateStandardWebhooksSecret(valid32).ok).toBe(true);
		expect(decodeStandardWebhooksKey(valid32)?.byteLength).toBe(32);

		// Invalid cases
		const invalid = [
			"",
			btoa("0123456789abcdef"), // missing prefix
			"whsec_", // empty
			`whsec_${btoa("0123456789abcde")}`, // 15 bytes (< 16)
			"whsec_not-valid-base64!!!",
			`whsec_${btoa("0123456789abcdef")}\n`,
			"whsec_====",
			"whsec_a", // invalid base64 length % 4 === 1
		];
		for (const raw of invalid) {
			expect(validateStandardWebhooksSecret(raw).ok, raw).toBe(false);
			expect(decodeStandardWebhooksKey(raw), raw).toBeNull();
		}
	});

	it("validates external secrets for bearer_header and custom_header", () => {
		expect(validateExternalSecret("tok_live_abc123._-")).toEqual({
			ok: true,
			secret: "tok_live_abc123._-",
		});

		const invalid = [
			"",
			"   ",
			"a".repeat(2049),
			"secret\r\nX-Injected: 1",
			"secret\nline2",
			"secret\0null",
			"secret\twith-tab",
			"日本語トークン",
			" secret",
			"secret ",
			" secret ",
		];
		for (const raw of invalid) {
			expect(validateExternalSecret(raw).ok, raw).toBe(false);
		}
		expect(validateExternalSecret(" secret")).toEqual({
			ok: false,
			message: "認証シークレットの前後に空白は含められません",
		});
		expect(validateExternalSecret("secret ")).toEqual({
			ok: false,
			message: "認証シークレットの前後に空白は含められません",
		});
	});

	it("generates distinct 256-bit paab_whsec_ secrets", () => {
		const s1 = generatePaabWebhookSecret();
		const s2 = generatePaabWebhookSecret();
		expect(s1).toMatch(/^paab_whsec_[0-9a-f]{64}$/);
		expect(s2).toMatch(/^paab_whsec_[0-9a-f]{64}$/);
		expect(s1).not.toBe(s2);
	});
});
