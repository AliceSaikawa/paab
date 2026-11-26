import { describe, expect, it } from "vitest";
import { isLocalWebhookAllowed, validateWebhookUrl } from "../../src/notify";

describe("isLocalWebhookAllowed", () => {
	it("returns true only when ALLOW_LOCAL_WEBHOOKS is strictly 'true'", () => {
		expect(isLocalWebhookAllowed(undefined)).toBe(false);
		expect(isLocalWebhookAllowed({})).toBe(false);
		expect(isLocalWebhookAllowed({ ALLOW_LOCAL_WEBHOOKS: "" })).toBe(false);
		expect(isLocalWebhookAllowed({ ALLOW_LOCAL_WEBHOOKS: "false" })).toBe(
			false,
		);
		expect(isLocalWebhookAllowed({ ALLOW_LOCAL_WEBHOOKS: "1" })).toBe(false);
		expect(isLocalWebhookAllowed({ ALLOW_LOCAL_WEBHOOKS: "TRUE" })).toBe(false);
		expect(isLocalWebhookAllowed({ ALLOW_LOCAL_WEBHOOKS: "true" })).toBe(true);
	});
});

describe("validateWebhookUrl", () => {
	it("accepts valid HTTPS public URLs and normalizes whitespace", () => {
		expect(validateWebhookUrl("  https://agent.example/webhook  ")).toEqual({
			ok: true,
			url: "https://agent.example/webhook",
		});
		expect(
			validateWebhookUrl("https://hooks.example.org:8443/paab?v=1"),
		).toEqual({
			ok: true,
			url: "https://hooks.example.org:8443/paab?v=1",
		});
		expect(validateWebhookUrl("https://93.184.216.34/wake")).toEqual({
			ok: true,
			url: "https://93.184.216.34/wake",
		});
		expect(validateWebhookUrl("https://[2606:4700:4700::1111]/wake")).toEqual({
			ok: true,
			url: "https://[2606:4700:4700::1111]/wake",
		});
	});

	it("accepts non-private IPv4 boundaries adjacent to private ranges", () => {
		expect(validateWebhookUrl("https://172.15.255.255/wake").ok).toBe(true);
		expect(validateWebhookUrl("https://172.32.0.1/wake").ok).toBe(true);
		expect(validateWebhookUrl("https://192.167.1.1/wake").ok).toBe(true);
		expect(validateWebhookUrl("https://100.128.0.1/wake").ok).toBe(true);
	});

	it.each([
		["empty string", ""],
		["whitespace only", "   "],
		["overlong URL", `https://agent.example/${"a".repeat(2040)}`],
		["control character", "https://agent.example/\nwebhook"],
		["malformed URL", "not a url"],
		["HTTP scheme by default", "http://agent.example/webhook"],
		["FTP scheme", "ftp://agent.example/webhook"],
		["javascript scheme", "javascript:alert(1)"],
		["file scheme", "file:///etc/passwd"],
		["embedded userinfo", "https://user:pass@agent.example/webhook"],
		["embedded username only", "https://user@agent.example/webhook"],
		["embedded password only", "https://:pass@agent.example/webhook"],
		["empty authority @", "https://@agent.example/webhook"],
		["localhost", "https://localhost/wake"],
		["localhost uppercase with trailing dot", "https://LOCALHOST./wake"],
		["subdomain of localhost", "https://api.localhost/wake"],
		[".local domain", "https://printer.local/wake"],
		[".local with trailing dot", "https://printer.local./wake"],
		[
			".internal domain",
			"https://metadata.google.internal/computeMetadata/v1/",
		],
		[".internal trailing dot", "https://service.internal./wake"],
		["single-label hostname", "https://intranet/wake"],
		["loopback IPv4", "https://127.0.0.1/wake"],
		["loopback IPv4 shorthand", "https://127.1/wake"],
		["loopback IPv4 hex", "https://0x7f000001/wake"],
		["loopback IPv4 decimal", "https://2130706433/wake"],
		["loopback IPv4 octal", "https://0177.0.0.1/wake"],
		["10.0.0.0/8", "https://10.20.30.40/wake"],
		["172.16.0.0/12 low", "https://172.16.0.1/wake"],
		["172.16.0.0/12 high", "https://172.31.255.254/wake"],
		["192.168.0.0/16", "https://192.168.1.50/wake"],
		["link-local metadata IPv4", "https://169.254.169.254/latest/meta-data"],
		["0.0.0.0/8", "https://0.0.0.0/wake"],
		["CGNAT 100.64.0.0/10", "https://100.64.0.1/wake"],
		["multicast IPv4", "https://224.0.0.1/wake"],
		["broadcast IPv4", "https://255.255.255.255/wake"],
		["IPv6 loopback", "https://[::1]/wake"],
		["IPv6 loopback expanded", "https://[0:0:0:0:0:0:0:1]/wake"],
		["IPv6 unspecified", "https://[::]/wake"],
		["IPv6 ULA fc00::/7", "https://[fc00::1]/wake"],
		["IPv6 ULA fd00::/8", "https://[fd12:3456:789a::1]/wake"],
		["IPv6 link-local fe80::/10", "https://[fe80::1]/wake"],
		["IPv6 multicast", "https://[ff02::1]/wake"],
		["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/wake"],
		["IPv4-mapped IPv6 private", "https://[::ffff:10.0.0.1]/wake"],
		["IPv4-mapped IPv6 metadata", "https://[::ffff:169.254.169.254]/wake"],
		["IPv4-mapped IPv6 192.168", "https://[::ffff:192.168.1.1]/wake"],
		["IPv4-compatible IPv6 loopback", "https://[::127.0.0.1]/wake"],
		["NAT64 IPv6 private", "https://[64:ff9b::10.0.0.1]/wake"],
	])("rejects %s when allowLocal is false", (_label, rawUrl) => {
		const res = validateWebhookUrl(rawUrl, false);
		expect(res.ok).toBe(false);
	});

	it("permits HTTP and local targets when allowLocal is true, while still rejecting credentials and unsafe schemes", () => {
		expect(validateWebhookUrl("http://localhost:8788/wake", true)).toEqual({
			ok: true,
			url: "http://localhost:8788/wake",
		});
		expect(validateWebhookUrl("http://127.0.0.1:8788/wake", true)).toEqual({
			ok: true,
			url: "http://127.0.0.1:8788/wake",
		});
		expect(validateWebhookUrl("http://[::1]:8788/wake", true)).toEqual({
			ok: true,
			url: "http://[::1]:8788/wake",
		});
		expect(validateWebhookUrl("https://agent.local/wake", true)).toEqual({
			ok: true,
			url: "https://agent.local/wake",
		});

		expect(validateWebhookUrl("ftp://localhost/wake", true).ok).toBe(false);
		expect(validateWebhookUrl("javascript:alert(1)", true).ok).toBe(false);
		expect(validateWebhookUrl("http://user:pass@localhost/wake", true).ok).toBe(
			false,
		);
	});
});
