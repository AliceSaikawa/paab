import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
	it("returns 200", async () => {
		const response = await SELF.fetch("http://example.com/health");
		expect(response.status).toBe(200);
	});
});
