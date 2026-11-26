import { describe, expect, it } from "vitest";
import {
	CliError,
	DEFAULT_REMOTE_CONFIG,
	wranglerTargetArgs,
} from "../../scripts/lib/sql";

describe("wranglerTargetArgs", () => {
	it("builds args for --local without requiring a local config file", async () => {
		await expect(
			wranglerTargetArgs({ local: true, hasConfigFile: () => false }),
		).resolves.toEqual(["--local"]);
	});

	it("includes --persist-to and --config for --local when provided", async () => {
		await expect(
			wranglerTargetArgs({
				local: true,
				persistTo: ".wrangler/custom",
			}),
		).resolves.toEqual(["--local", "--persist-to", ".wrangler/custom"]);

		await expect(
			wranglerTargetArgs({
				local: true,
				config: "custom.jsonc",
			}),
		).resolves.toEqual(["--local", "--config", "custom.jsonc"]);
	});

	it("defaults --remote to wrangler.local.jsonc when it exists", async () => {
		const checked: string[] = [];
		await expect(
			wranglerTargetArgs({
				remote: true,
				hasConfigFile: (path) => {
					checked.push(path);
					return path === DEFAULT_REMOTE_CONFIG;
				},
			}),
		).resolves.toEqual(["--remote", "--config", "wrangler.local.jsonc"]);
		expect(checked).toEqual(["wrangler.local.jsonc"]);
	});

	it("uses a custom --config path for --remote when provided", async () => {
		await expect(
			wranglerTargetArgs({
				remote: true,
				config: "custom.jsonc",
				hasConfigFile: async (path) => path === "custom.jsonc",
			}),
		).resolves.toEqual(["--remote", "--config", "custom.jsonc"]);
	});

	it("throws CliError when --remote config file is missing", async () => {
		const defaultError = await wranglerTargetArgs({
			remote: true,
			hasConfigFile: () => false,
		}).catch((error: unknown) => error);
		expect(defaultError).toBeInstanceOf(CliError);
		expect((defaultError as Error).message).toContain("wrangler.local.jsonc");
		expect((defaultError as Error).message).toContain(
			"wrangler.jsonc を wrangler.local.jsonc に写し",
		);

		const customError = await wranglerTargetArgs({
			remote: true,
			config: "missing.jsonc",
			hasConfigFile: () => false,
		}).catch((error: unknown) => error);
		expect(customError).toBeInstanceOf(CliError);
		expect((customError as Error).message).toContain("missing.jsonc");
		expect((customError as Error).message).not.toContain(
			"wrangler.local.jsonc",
		);
	});

	it("throws CliError when --local and --remote are both set or both omitted", async () => {
		await expect(
			wranglerTargetArgs({ local: true, remote: true }),
		).rejects.toBeInstanceOf(CliError);
		await expect(wranglerTargetArgs({})).rejects.toBeInstanceOf(CliError);
	});
});
