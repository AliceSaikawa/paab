import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
	test: {
		maxWorkers: 4,
		exclude: [
			"**/node_modules/**",
			"**/.git/**",
			"**/.agents/**",
			"**/.audit/**",
		],
	},
});
