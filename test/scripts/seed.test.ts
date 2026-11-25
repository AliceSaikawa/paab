import { beforeEach, describe, expect, it } from "vitest";
import { loadSeed, parseSeed } from "../../scripts/lib/seed";
import { CliError } from "../../scripts/lib/sql";
import { newId } from "../../src/db";
import { listAllowedRecipients } from "../../src/policy";
import { createTestDb } from "../helpers/db";
import { T0 } from "../helpers/fixtures";
import { d1Client, EXAMPLE_SEED, snapshot } from "./support";

let db: D1Database;

beforeEach(async () => {
	db = await createTestDb();
});

function seedText(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ ...JSON.parse(EXAMPLE_SEED), ...overrides });
}

async function agentId(name: string): Promise<string> {
	const row = await db
		.prepare("SELECT id FROM agents WHERE name = ?")
		.bind(name)
		.first<{ id: string }>();
	if (row === null) {
		throw new Error(`no agent ${name}`);
	}
	return row.id;
}

async function rejection(text: string): Promise<string> {
	const before = await snapshot(db);
	const error = await loadSeed(d1Client(db), text, T0, newId).catch(
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(CliError);
	expect(await snapshot(db)).toEqual(before);
	return (error as CliError).message;
}

describe("the sample seed file", () => {
	it("loads agents, categories and rules that the bridge then reads", async () => {
		const summary = await loadSeed(d1Client(db), EXAMPLE_SEED, T0, newId);
		expect(summary).toEqual({ agents: 2, categories: 8, allowRules: 4 });

		const agents = await db
			.prepare(
				"SELECT name, owner_id, status, daily_question_limit, created_at FROM agents ORDER BY name",
			)
			.all();
		expect(agents.results).toEqual([
			{
				name: "grok",
				owner_id: "me",
				status: "active",
				daily_question_limit: 20,
				created_at: T0,
			},
			{
				name: "muse",
				owner_id: "me",
				status: "active",
				daily_question_limit: 20,
				created_at: T0,
			},
		]);

		const categories = await db
			.prepare("SELECT name FROM categories ORDER BY name")
			.all<{ name: string }>();
		expect(categories.results.map((row) => row.name).sort()).toEqual(
			[
				"予定",
				"連絡先",
				"好み・習慣",
				"仕事",
				"健康",
				"金融",
				"位置情報",
				"その他",
			].sort(),
		);

		expect(await listAllowedRecipients(db, await agentId("muse"))).toEqual([
			{
				name: "grok",
				description: "仕事の調べものと好みの記録を担当するエージェント。",
				categories: ["仕事", "好み・習慣"].sort(),
			},
		]);
		expect(await listAllowedRecipients(db, await agentId("grok"))).toEqual([
			{
				name: "muse",
				description: "日々の予定と連絡先を管理しているエージェント。",
				categories: ["予定", "連絡先"].sort(),
			},
		]);
	});

	it("allows その他 to nobody", async () => {
		const seed = parseSeed(EXAMPLE_SEED);
		expect(seed.ok).toBe(true);
		if (seed.ok) {
			expect(seed.seed.categories).toContain("その他");
			expect(
				seed.seed.allowRules.flatMap((rule) => rule.categories),
			).not.toContain("その他");
		}
	});
});

describe("loadSeed", () => {
	it("refuses a second load and leaves the data as it was", async () => {
		await loadSeed(d1Client(db), EXAMPLE_SEED, T0, newId);
		const message = await rejection(EXAMPLE_SEED);
		expect(message).toContain("すでにデータがあります");
	});

	it("refuses a database that only has categories", async () => {
		await db.prepare("INSERT INTO categories VALUES ('c', 'x')").run();
		expect(await rejection(EXAMPLE_SEED)).toContain("カテゴリ 1 件");
	});

	it("stores quotes and semicolons in text as written", async () => {
		const description = "it's; DROP TABLE agents; --";
		await loadSeed(
			d1Client(db),
			seedText({
				agents: [{ name: "a'b", description, dailyQuestionLimit: 0 }],
				allowRules: [],
			}),
			T0,
			newId,
		);
		const row = await db
			.prepare("SELECT name, description FROM agents")
			.first();
		expect(row).toEqual({ name: "a'b", description });
	});
});

describe("invalid seed files", () => {
	const agents = [
		{ name: "a", description: "", dailyQuestionLimit: 5 },
		{ name: "b", description: "", dailyQuestionLimit: 5 },
	];

	it.each([
		["text that is not JSON", "{", "JSON として読めません"],
		[
			"a rule naming an unknown agent",
			seedText({
				allowRules: [{ from: "muse", to: "ghost", categories: ["予定"] }],
			}),
			"allowRules[0].to: エージェント「ghost」は agents にありません",
		],
		[
			"a rule naming an unknown category",
			seedText({
				allowRules: [{ from: "muse", to: "grok", categories: ["趣味"] }],
			}),
			"allowRules[0].categories[0]: カテゴリ「趣味」は categories にありません",
		],
		[
			"a duplicated agent name",
			seedText({ agents: [agents[0], agents[0]], allowRules: [] }),
			"agents[1].name: エージェント名「a」が重複しています（agents[0].name と同じ）",
		],
		[
			"a duplicated category",
			seedText({ categories: ["予定", "予定"], allowRules: [] }),
			"categories[1]: カテゴリ「予定」が重複しています（categories[0] と同じ）",
		],
		[
			"a rule from an agent to itself",
			seedText({
				agents,
				allowRules: [{ from: "a", to: "a", categories: ["予定"] }],
			}),
			"allowRules[0]: 送信元と宛先が同じエージェント「a」です",
		],
		[
			"a rule listed twice",
			seedText({
				agents,
				allowRules: [
					{ from: "a", to: "b", categories: ["予定"] },
					{ from: "a", to: "b", categories: ["予定"] },
				],
			}),
			"allowRules[1].categories[0]: 「a」から「b」への「予定」の許可が重複しています（allowRules[0].categories[0] と同じ）",
		],
		[
			"a negative daily limit",
			seedText({
				agents: [{ ...agents[0], dailyQuestionLimit: -1 }],
				allowRules: [],
			}),
			"agents[0].dailyQuestionLimit:",
		],
		["a missing owner", seedText({ ownerId: undefined }), "ownerId:"],
		["an unknown key", seedText({ rules: [] }), "(ファイル全体):"],
	])("rejects %s without touching D1", async (_, text, expected) => {
		const message = await rejection(text);
		expect(message).toContain("D1 は変更していません");
		expect(message).toContain(expected);
	});

	it("reports every problem at once", async () => {
		const result = parseSeed(
			seedText({
				agents: [agents[0], agents[0]],
				allowRules: [{ from: "x", to: "y", categories: ["z"] }],
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(4);
		}
	});

	it.each([
		[
			"an empty agent name",
			seedText({
				agents: [{ name: "  \n ", description: "", dailyQuestionLimit: 5 }],
				allowRules: [],
			}),
			"agents[0].name:",
		],
		[
			"an oversized agent name",
			seedText({
				agents: [
					{ name: "a".repeat(65), description: "", dailyQuestionLimit: 5 },
				],
				allowRules: [],
			}),
			"agents[0].name:",
		],
		[
			"a category name with comma or bidi override",
			seedText({
				categories: ["予定", "a\u202eb"],
				allowRules: [],
			}),
			"categories[1]:",
		],
		[
			"an agent description with a disallowed control char",
			seedText({
				agents: [
					{ name: "a", description: "bad\u0007", dailyQuestionLimit: 5 },
				],
				allowRules: [],
			}),
			"agents[0].description:",
		],
		[
			"NFC-equivalent duplicate agent names",
			seedText({
				agents: [
					{ name: "が", description: "", dailyQuestionLimit: 5 },
					{ name: "か\u3099", description: "", dailyQuestionLimit: 5 },
				],
				allowRules: [],
			}),
			"agents[1].name: エージェント名「が」が重複しています（agents[0].name と同じ）",
		],
		[
			"NFC-equivalent duplicate category names",
			seedText({
				categories: ["が", "か\u3099"],
				allowRules: [],
			}),
			"categories[1]: カテゴリ「が」が重複しています（categories[0] と同じ）",
		],
	])(
		"validates naming rules for %s with file path",
		async (_, text, expected) => {
			const message = await rejection(text);
			expect(message).toContain(expected);
		},
	);
});
