import {
	createExecutionContext,
	createScheduledController,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { readAuditLog } from "../../scripts/lib/audit";
import { loadSeed, type Seed } from "../../scripts/lib/seed";
import { issueParticipantToken } from "../../scripts/lib/token";
import { newId } from "../../src/db/client";
import worker from "../../src/index";
import { createTestDb } from "../helpers/db";
import { withoutFooter } from "../mcp/support";
import { d1Client } from "../scripts/support";

export const QUESTION = "来週の火曜日は空いていますか？";
export const ANSWER = "火曜日の午後は空いています。";

/** alice may ask bob about 予定. Nothing else is allowed. */
export const SEED: Seed = {
	ownerId: "owner",
	agents: [
		{
			name: "alice",
			description: "仕事の調べものを担当するエージェント。",
			dailyQuestionLimit: 20,
		},
		{
			name: "bob",
			description: "日々の予定を管理しているエージェント。",
			dailyQuestionLimit: 20,
		},
	],
	categories: ["予定", "健康", "その他"],
	allowRules: [{ from: "alice", to: "bob", categories: ["予定"] }],
};

export type AgentName = "alice" | "bob";

/** A bridge set up the way an operator does it: seed, then one token each. */
export interface Bridge {
	tokens: Record<AgentName, string>;
}

/**
 * Empties the database, then loads the seed and issues the tokens through
 * the same functions `npm run seed` and `npm run token` run.
 */
export async function startBridge(seed: Seed = SEED): Promise<Bridge> {
	const db = d1Client(await createTestDb());
	await loadSeed(db, JSON.stringify(seed), Date.now(), newId);
	const issue = async (name: AgentName) =>
		(await issueParticipantToken(db, name, Date.now())).token;
	return { tokens: { alice: await issue("alice"), bob: await issue("bob") } };
}

/** Connects an MCP client to the Worker's `/mcp` with the agent's token. */
export async function connect(
	bridge: Bridge,
	name: AgentName,
): Promise<Client> {
	const client = new Client({ name: `paab-e2e-${name}`, version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(
		new URL("https://paab.test/mcp"),
		{
			fetch: (input, init) => SELF.fetch(new Request(input, init)),
			requestInit: {
				headers: { Authorization: `Bearer ${bridge.tokens[name]}` },
			},
		},
	);
	await client.connect(transport);
	return client;
}

/** Runs the Worker's cron handler, as the hourly trigger does. */
export async function runCron(): Promise<void> {
	const ctx = createExecutionContext();
	await worker.scheduled(
		createScheduledController({ scheduledTime: Date.now() }),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
}

/** The audit log as `npm run audit-log -- --body` reads it. */
export async function auditLog() {
	return readAuditLog(d1Client(env.DB), { includeBody: true });
}

/** The messages in a `check_inbox` result, one block of lines each. */
export function inboxMessages(text: string): string[] {
	return withoutFooter(text)
		.split("\n\n")
		.filter((block) => block.startsWith("kind: "));
}

/** The text with every message and question ID blanked. */
export function maskIds(text: string): string {
	return text.replace(/^((?:message|question)_id): \S+$/gm, "$1: *");
}
