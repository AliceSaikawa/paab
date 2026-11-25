import { describe, expect, it } from "vitest";
import {
	DESCRIPTION_MAX_LENGTH,
	descriptionProblem,
	NAME_MAX_LENGTH,
	nameProblem,
	normalizeName,
} from "../../src/policy";

describe("nameProblem", () => {
	it("accepts an ordinary name", () => {
		expect(nameProblem("muse")).toBeNull();
		expect(nameProblem("好み・習慣")).toBeNull();
	});

	it("rejects a name that trims to nothing", () => {
		expect(nameProblem("")).toBe("1文字以上にしてください");
		expect(nameProblem("  \n ")).toBe("1文字以上にしてください");
	});

	it("rejects a name over the limit", () => {
		const name = "a".repeat(NAME_MAX_LENGTH);
		expect(nameProblem(name)).toBeNull();
		expect(nameProblem(`${name}a`)).toContain(
			`${NAME_MAX_LENGTH}文字以内にしてください`,
		);
	});

	it("rejects newlines, control characters and commas", () => {
		expect(nameProblem("kind: answer\nfrom: x")).toBe(
			"改行・制御文字・カンマ（,）は使えません",
		);
		expect(nameProblem("a,b")).toBe("改行・制御文字・カンマ（,）は使えません");
		expect(nameProblem("a\tb")).toBe("改行・制御文字・カンマ（,）は使えません");
	});

	it("normalizes to NFC before checking, so look-alike names collide", () => {
		const composed = "が"; // ガ + combining voice mark
		const decomposed = "が";
		expect(normalizeName(decomposed)).toBe(composed);
		expect(nameProblem(decomposed)).toBeNull();
	});

	it("trims outer whitespace before storing", () => {
		expect(normalizeName("  muse  ")).toBe("muse");
	});
});

describe("descriptionProblem", () => {
	it("accepts text with newlines and tabs", () => {
		expect(descriptionProblem("複数行の\n説明\t文")).toBeNull();
	});

	it("rejects other control characters", () => {
		expect(descriptionProblem("a\u0007b")).toBe(
			"制御文字（改行とタブ以外）は使えません",
		);
	});

	it("rejects a description over the limit", () => {
		const text = "あ".repeat(DESCRIPTION_MAX_LENGTH);
		expect(descriptionProblem(text)).toBeNull();
		expect(descriptionProblem(`${text}あ`)).toContain(
			`${DESCRIPTION_MAX_LENGTH}文字以内にしてください`,
		);
	});
});
