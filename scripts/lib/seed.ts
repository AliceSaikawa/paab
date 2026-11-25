import { z } from "zod";
import {
	descriptionProblem,
	nameProblem,
	normalizeDescription,
	normalizeName,
} from "../../src/policy";
import type { UnixMillis } from "../../src/types";
import { CliError, type D1Client, sql } from "./sql";

// Names and descriptions are normalized and validated with the shared
// rules in src/policy/naming.ts, so that the admin operations (#29)
// enforce exactly what the seed loader enforces.
const name = z
	.string()
	.transform(normalizeName)
	.refine((value) => nameProblem(value) === null, {
		error: (issue) => nameProblem(String(issue.input)) ?? "",
	});

const description = z
	.string()
	.transform(normalizeDescription)
	.refine((value) => descriptionProblem(value) === null, {
		error: (issue) => descriptionProblem(String(issue.input)) ?? "",
	});

const seedSchema = z.strictObject({
	ownerId: name,
	agents: z
		.array(
			z.strictObject({
				name,
				description,
				dailyQuestionLimit: z.int().min(0),
			}),
		)
		.min(1),
	categories: z.array(name).min(1),
	allowRules: z.array(
		z.strictObject({
			from: name,
			to: name,
			categories: z.array(name).min(1),
		}),
	),
});

/** The contents of a seed file (`paab.seed.example.json` shows one). */
export type Seed = z.infer<typeof seedSchema>;

export type SeedParseResult =
	| { ok: true; seed: Seed }
	| { ok: false; errors: string[] };

function formatPath(path: readonly PropertyKey[]): string {
	let text = "";
	for (const key of path) {
		text +=
			typeof key === "number" ? `[${key}]` : `${text ? "." : ""}${String(key)}`;
	}
	return text || "(ファイル全体)";
}

/** Reports every name that appears more than once in `items`. */
function findDuplicates(
	names: string[],
	pathOf: (index: number) => string,
	label: string,
): string[] {
	const firstIndex = new Map<string, number>();
	const errors: string[] = [];
	names.forEach((value, index) => {
		const first = firstIndex.get(value);
		if (first === undefined) {
			firstIndex.set(value, index);
		} else {
			errors.push(
				`${pathOf(index)}: ${label}「${value}」が重複しています（${pathOf(first)} と同じ）`,
			);
		}
	});
	return errors;
}

/** Checks what the schema cannot: names must be unique and resolve. */
function crossCheck(seed: Seed): string[] {
	const agentNames = new Set(seed.agents.map((agent) => agent.name));
	const categoryNames = new Set(seed.categories);
	const errors = [
		...findDuplicates(
			seed.agents.map((agent) => agent.name),
			(i) => `agents[${i}].name`,
			"エージェント名",
		),
		...findDuplicates(seed.categories, (i) => `categories[${i}]`, "カテゴリ"),
	];

	const seenRules = new Map<string, string>();
	seed.allowRules.forEach((rule, i) => {
		const at = `allowRules[${i}]`;
		for (const end of ["from", "to"] as const) {
			if (!agentNames.has(rule[end])) {
				errors.push(
					`${at}.${end}: エージェント「${rule[end]}」は agents にありません`,
				);
			}
		}
		if (rule.from === rule.to) {
			errors.push(
				`${at}: 送信元と宛先が同じエージェント「${rule.from}」です。自分自身への質問は許可できません`,
			);
		}
		rule.categories.forEach((category, j) => {
			const path = `${at}.categories[${j}]`;
			if (!categoryNames.has(category)) {
				errors.push(
					`${path}: カテゴリ「${category}」は categories にありません`,
				);
				return;
			}
			const key = JSON.stringify([rule.from, rule.to, category]);
			const first = seenRules.get(key);
			if (first === undefined) {
				seenRules.set(key, path);
			} else {
				errors.push(
					`${path}: 「${rule.from}」から「${rule.to}」への「${category}」の許可が重複しています（${first} と同じ）`,
				);
			}
		});
	});
	return errors;
}

/**
 * Parses and validates the text of a seed file. Reports every problem found,
 * each prefixed with where it is in the file, rather than stopping at the
 * first one.
 */
export function parseSeed(text: string): SeedParseResult {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			errors: [`JSON として読めません: ${(error as Error).message}`],
		};
	}
	const parsed = seedSchema.safeParse(json, {
		error: z.locales.ja().localeError,
	});
	if (!parsed.success) {
		return {
			ok: false,
			errors: parsed.error.issues.map(
				(issue) => `${formatPath(issue.path)}: ${issue.message}`,
			),
		};
	}
	const errors = crossCheck(parsed.data);
	return errors.length > 0
		? { ok: false, errors }
		: { ok: true, seed: parsed.data };
}

/** The INSERT statements for a valid seed, in foreign key order. */
export function seedStatements(
	seed: Seed,
	now: UnixMillis,
	newId: () => string,
): string[] {
	const agentIds = new Map(seed.agents.map((agent) => [agent.name, newId()]));
	const categoryIds = new Map(seed.categories.map((c) => [c, newId()]));
	const idOf = (ids: Map<string, string>, key: string) => {
		const id = ids.get(key);
		if (id === undefined) {
			throw new Error(`unresolved name in a validated seed: ${key}`);
		}
		return id;
	};

	return [
		...seed.agents.map((agent) =>
			sql(
				`INSERT INTO agents
					(id, owner_id, name, description, status, daily_question_limit, created_at)
				VALUES (?, ?, ?, ?, 'active', ?, ?)`,
				idOf(agentIds, agent.name),
				seed.ownerId,
				agent.name,
				agent.description,
				agent.dailyQuestionLimit,
				now,
			),
		),
		...seed.categories.map((category) =>
			sql(
				"INSERT INTO categories (id, name) VALUES (?, ?)",
				idOf(categoryIds, category),
				category,
			),
		),
		...seed.allowRules.flatMap((rule) =>
			rule.categories.map((category) =>
				sql(
					`INSERT INTO allow_rules
						(from_agent_id, to_agent_id, category_id, created_at)
					VALUES (?, ?, ?, ?)`,
					idOf(agentIds, rule.from),
					idOf(agentIds, rule.to),
					idOf(categoryIds, category),
					now,
				),
			),
		),
	];
}

export interface SeedSummary {
	agents: number;
	categories: number;
	allowRules: number;
}

/**
 * Validates a seed file and loads it into an empty database. Throws a
 * `CliError` without touching the database when the file is invalid or the
 * database already holds agents, categories or rules.
 */
export async function loadSeed(
	db: D1Client,
	text: string,
	now: UnixMillis,
	newId: () => string,
): Promise<SeedSummary> {
	const parsed = parseSeed(text);
	if (!parsed.ok) {
		throw new CliError(
			`初期値ファイルに誤りがあります（${parsed.errors.length} 件）。D1 は変更していません。\n${parsed.errors
				.map((error) => `  - ${error}`)
				.join("\n")}`,
		);
	}

	// audit_log is left out: a deployed Worker records failed authentication
	// before anything is seeded. Tokens and messages cannot exist without
	// agents.
	const [existing = {}] = await db.query(
		`SELECT
			(SELECT count(*) FROM agents) AS agents,
			(SELECT count(*) FROM categories) AS categories,
			(SELECT count(*) FROM allow_rules) AS allow_rules`,
	);
	if (Object.values(existing).some((count) => count !== 0)) {
		throw new CliError(
			`D1 にはすでにデータがあります（エージェント ${existing.agents} 件、カテゴリ ${existing.categories} 件、許可ルール ${existing.allow_rules} 件）。初期値の投入は空の D1 にだけ行えます。D1 は変更していません。`,
		);
	}

	await db.execute(seedStatements(parsed.seed, now, newId));
	return {
		agents: parsed.seed.agents.length,
		categories: parsed.seed.categories.length,
		allowRules: parsed.seed.allowRules.reduce(
			(count, rule) => count + rule.categories.length,
			0,
		),
	};
}
