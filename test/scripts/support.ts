import type { D1Client, Row } from "../../scripts/lib/sql";

const exampleFiles = import.meta.glob<string>("../../paab.seed.example.json", {
	query: "?raw",
	import: "default",
	eager: true,
});

/** The text of the tracked sample seed file. */
export const EXAMPLE_SEED = Object.values(exampleFiles)[0] ?? "";

/**
 * Backs the commands with the test D1 the same way local wrangler runs them:
 * reads through `prepare`, writes through one `batch`.
 */
export function d1Client(db: D1Database): D1Client {
	return {
		async query(statement) {
			return (await db.prepare(statement).all<Row>()).results;
		},
		async execute(statements) {
			await db.batch(statements.map((statement) => db.prepare(statement)));
		},
	};
}

/** Every row the seed and token commands may write, for change detection. */
export async function snapshot(db: D1Database): Promise<Row[][]> {
	const tables = ["agents", "categories", "allow_rules", "tokens"];
	return Promise.all(
		tables.map(
			async (table) =>
				(await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all<Row>())
					.results,
		),
	);
}
