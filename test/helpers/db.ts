import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Every migration file, loaded as text at build time. This keeps the tests on
// the real files in `migrations/` without adding bindings to the Vitest
// configuration.
const migrationFiles = import.meta.glob<string>("../../migrations/*.sql", {
	query: "?raw",
	import: "default",
	eager: true,
});

/**
 * Splits a migration file into statements. It only understands `--` line
 * comments and `;` terminators, so migrations must not put a semicolon inside
 * a string literal, a comment or a trigger body.
 */
function splitStatements(sql: string): string[] {
	return sql
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("--"))
		.join("\n")
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

const migrations: D1Migration[] = Object.entries(migrationFiles)
	.map(([path, sql]) => ({
		name: path.slice(path.lastIndexOf("/") + 1),
		queries: splitStatements(sql),
	}))
	.sort((a, b) => a.name.localeCompare(b.name));

// Children before parents, so that foreign keys hold while emptying.
const TABLES = [
	"pending_descriptions",
	"proposals",
	"admin_bot_config",
	"change_log",
	"audit_log",
	"messages",
	"allow_rules",
	"tokens",
	"categories",
	"agents",
] as const;

/**
 * Returns the test D1 database with every migration applied and every table
 * empty. Call it in `beforeEach`.
 */
export async function createTestDb(): Promise<D1Database> {
	const db = env.DB;
	await applyD1Migrations(db, migrations);
	await db.batch(TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)));
	return db;
}
