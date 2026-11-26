// Entry point of the management commands. It only does what needs Node:
// reading arguments and files, running wrangler, and printing. The commands
// themselves live in `scripts/lib`, where the tests run them against D1.
//
// This file is type-checked with the Node definitions through
// tsconfig.scripts.json. `npm run seed` and the others bundle it with
// esbuild before running it.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
	DEFAULT_AUDIT_QUERY_LIMIT,
	MAX_AUDIT_QUERY_LIMIT,
} from "../src/audit/query";
import { newId } from "../src/db/client";
import { auditLogFilter, formatAuditLog, readAuditLog } from "./lib/audit";
import { loadSeed } from "./lib/seed";
import {
	CliError,
	type D1Client,
	parseWranglerRows,
	wranglerFailure,
} from "./lib/sql";
import { issueParticipantToken } from "./lib/token";

const USAGE = `使い方:
  npm run seed -- (--local | --remote) [--file paab.seed.json]
  npm run token -- (--local | --remote) <エージェント名>
  npm run audit-log -- (--local | --remote) [--since 日時] [--before 日時]
      [--from 送信元] [--to 宛先] [--category カテゴリ]
      [--outcome ok|denied|expired] [--limit 件数] [--body]
      [--oldest] [--after-id ID] [--before-id ID]

共通: --persist-to <ディレクトリ> でローカル D1 の保存先を変えられます（--local のときだけ）。
詳しくは docs/setup.md を参照してください。`;

const WRANGLER = join(
	dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
	"bin/wrangler.js",
);

const run = promisify(execFile);

function wranglerClient(target: string[]): D1Client {
	const wrangler = async (args: string[]) => {
		try {
			const { stdout } = await run(
				process.execPath,
				[
					WRANGLER,
					"d1",
					"execute",
					"DB",
					...target,
					"--json",
					"--yes",
					...args,
				],
				{ maxBuffer: 64 * 1024 * 1024 },
			);
			return stdout;
		} catch (error) {
			const { stdout = "", stderr = "" } = error as {
				stdout?: string;
				stderr?: string;
			};
			throw new CliError(
				`D1 の操作に失敗しました: ${wranglerFailure(stdout, stderr)}`,
			);
		}
	};
	return {
		async query(statement) {
			return parseWranglerRows(await wrangler(["--command", statement]));
		},
		async execute(statements) {
			const dir = await mkdtemp(join(tmpdir(), "paab-"));
			try {
				const file = join(dir, "statements.sql");
				await writeFile(file, `${statements.join(";\n")};\n`);
				await wrangler(["--file", file]);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	};
}

async function main(argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			local: { type: "boolean" },
			remote: { type: "boolean" },
			"persist-to": { type: "string" },
			file: { type: "string" },
			since: { type: "string" },
			before: { type: "string" },
			from: { type: "string" },
			to: { type: "string" },
			category: { type: "string" },
			outcome: { type: "string" },
			limit: { type: "string" },
			body: { type: "boolean" },
			oldest: { type: "boolean" },
			"after-id": { type: "string" },
			"before-id": { type: "string" },
			help: { type: "boolean" },
		},
	});
	const [command, ...operands] = positionals;
	if (values.help || command === undefined) {
		console.log(USAGE);
		return;
	}
	if (values.local === values.remote) {
		throw new CliError(
			"--local（ローカルの D1）か --remote（本番の D1）のどちらか一方を指定してください。",
		);
	}
	const target = values.local
		? [
				"--local",
				...(values["persist-to"] ? ["--persist-to", values["persist-to"]] : []),
			]
		: ["--remote"];
	if (command !== "token" && operands.length > 0) {
		throw new CliError(
			`余分な引数があります: ${operands.join(" ")}\n\n${USAGE}`,
		);
	}
	const db = wranglerClient(target);
	const where = values.local ? "ローカルの D1" : "本番の D1";

	switch (command) {
		case "seed": {
			const path = values.file ?? "paab.seed.json";
			const text = await readFile(path, "utf8").catch(() => {
				throw new CliError(
					`初期値ファイル ${path} を読めません。paab.seed.example.json を写して作ってください。`,
				);
			});
			const summary = await loadSeed(db, text, Date.now(), newId);
			console.log(
				`${where} に投入しました: エージェント ${summary.agents} 件、カテゴリ ${summary.categories} 件、許可ルール ${summary.allowRules} 件。`,
			);
			return;
		}
		case "token": {
			const [name, ...extra] = operands;
			if (name === undefined || extra.length > 0) {
				throw new CliError("エージェント名を1つだけ指定してください。");
			}
			const issued = await issueParticipantToken(db, name, Date.now());
			console.error(
				`${where} で「${name}」のトークンを発行しました。${issued.revokedPrevious ? "古いトークンは無効にしました。" : ""}この表示は一度きりです。`,
			);
			console.log(issued.token);
			return;
		}
		case "audit-log": {
			const filter = auditLogFilter(values);
			const entries = await readAuditLog(db, filter);
			console.log(formatAuditLog(entries, filter.includeBody === true));
			console.error(`${entries.length} 件`);
			const limit = Math.min(
				filter.limit ?? DEFAULT_AUDIT_QUERY_LIMIT,
				MAX_AUDIT_QUERY_LIMIT,
			);
			const last = entries.at(-1);
			if (entries.length === limit && last !== undefined) {
				const cursor =
					filter.order === "asc"
						? `--after-id ${last.id}`
						: `--before-id ${last.id}`;
				console.error(
					`表示は最大 ${limit} 件までです。続きがある可能性があります。続きを読むには ${cursor} を付けてください。`,
				);
			}
			return;
		}
		default:
			throw new CliError(`不明なコマンドです: ${command}\n\n${USAGE}`);
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	if (error instanceof CliError || error instanceof RangeError) {
		console.error(error.message);
	} else if (
		error instanceof TypeError &&
		String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS")
	) {
		console.error(`${error.message}\n\n${USAGE}`);
	} else {
		console.error(error);
	}
	process.exitCode = 1;
});
