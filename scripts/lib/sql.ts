import { inlineAuditLogQuery } from "../../src/audit/query";

export type Row = Record<string, unknown>;

/**
 * The commands talk to D1 only through this, so tests can back it with the
 * test D1 and the CLI with `wrangler d1 execute`. Reads and writes are apart
 * because remote D1 returns rows only for `--command`, and runs a `--file`
 * as one unit that rolls back on failure.
 */
export interface D1Client {
	/** Runs one read-only statement and returns its rows. */
	query(statement: string): Promise<Row[]>;
	/** Runs the statements as one transaction. */
	execute(statements: string[]): Promise<void>;
}

/** A failure the user can fix. The CLI prints the message without a stack. */
export class CliError extends Error {
	override name = "CliError";
}

/**
 * Writes the values into the `?` placeholders as SQL literals, because
 * `wrangler d1 execute` cannot bind parameters.
 */
export function sql(text: string, ...params: (string | number)[]): string {
	return inlineAuditLogQuery({ sql: text, params });
}

/**
 * Reads the rows of the single statement in the output of
 * `wrangler d1 execute --json --command`.
 */
export function parseWranglerRows(stdout: string): Row[] {
	const output: unknown = JSON.parse(stdout);
	const first = Array.isArray(output) ? output[0] : undefined;
	if (!Array.isArray(first?.results)) {
		throw new Error(`unexpected wrangler output: ${stdout.slice(0, 200)}`);
	}
	return first.results;
}

/**
 * The reason wrangler gives for a failed `d1 execute --json`. Falls back to
 * what it wrote to stderr when stdout holds no JSON error.
 */
export function wranglerFailure(stdout: string, stderr: string): string {
	try {
		const text = JSON.parse(stdout)?.error?.text;
		if (typeof text === "string") {
			return text;
		}
	} catch {}
	return stderr.trim() || stdout.trim() || "wrangler failed without output";
}
