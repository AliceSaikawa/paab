import { describe, expect, it } from "vitest";
import {
	AUDIT_BODY_RECORDING_DISABLED,
	isBodyRecordingEnabled,
	parseAuditBodyConfig,
} from "../../src/audit";

describe("parseAuditBodyConfig", () => {
	it("enables recording for a true flag and a positive number of days", () => {
		expect(
			parseAuditBodyConfig({ recordBodies: "true", bodyRetentionDays: "30" }),
		).toEqual({ recordBodies: true, bodyRetentionDays: 30 });
		expect(
			parseAuditBodyConfig({ recordBodies: true, bodyRetentionDays: 7 }),
		).toEqual({ recordBodies: true, bodyRetentionDays: 7 });
		expect(
			parseAuditBodyConfig({
				recordBodies: " TRUE ",
				bodyRetentionDays: " 1 ",
			}),
		).toEqual({ recordBodies: true, bodyRetentionDays: 1 });
	});

	it.each([
		["nothing set", {}],
		["flag missing", { bodyRetentionDays: "30" }],
		["flag false", { recordBodies: "false", bodyRetentionDays: "30" }],
		["flag not a boolean word", { recordBodies: "1", bodyRetentionDays: "30" }],
		["flag of another type", { recordBodies: 1, bodyRetentionDays: "30" }],
		["days missing", { recordBodies: "true" }],
		["days empty", { recordBodies: "true", bodyRetentionDays: "" }],
		["days zero", { recordBodies: "true", bodyRetentionDays: "0" }],
		["days negative", { recordBodies: "true", bodyRetentionDays: "-3" }],
		["days fractional", { recordBodies: "true", bodyRetentionDays: "1.5" }],
		["days fractional number", { recordBodies: true, bodyRetentionDays: 1.5 }],
		["days with a unit", { recordBodies: "true", bodyRetentionDays: "30d" }],
		[
			"days in exponent form",
			{ recordBodies: "true", bodyRetentionDays: "1e2" },
		],
		[
			"days too large",
			{ recordBodies: "true", bodyRetentionDays: "9".repeat(30) },
		],
		[
			"days not a number",
			{ recordBodies: true, bodyRetentionDays: Number.NaN },
		],
	])("falls back to disabled: %s", (_name, raw) => {
		expect(parseAuditBodyConfig(raw)).toEqual(AUDIT_BODY_RECORDING_DISABLED);
	});
});

describe("isBodyRecordingEnabled", () => {
	it("is off by default", () => {
		expect(isBodyRecordingEnabled(AUDIT_BODY_RECORDING_DISABLED)).toBe(false);
	});

	it("is off when recording is on without a usable retention period", () => {
		for (const bodyRetentionDays of [0, -1, 1.5, Number.NaN, Infinity]) {
			expect(
				isBodyRecordingEnabled({ recordBodies: true, bodyRetentionDays }),
			).toBe(false);
		}
	});

	it("is on with a positive whole number of days", () => {
		expect(
			isBodyRecordingEnabled({ recordBodies: true, bodyRetentionDays: 1 }),
		).toBe(true);
	});
});
