import { env } from "cloudflare:workers";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { issueToken } from "../../src/auth";
import { insertAllowRule } from "../../src/db";
import { handleMcpRequest } from "../../src/mcp";
import type { McpEnv } from "../../src/mcp/config";
import type { Agent, Category } from "../../src/types";
import { createTestDb } from "../helpers/db";
import { seedAgent, seedCategory, T0 } from "../helpers/fixtures";

export const MCP_URL = "https://paab.test/mcp";

export interface Participant {
	agent: Agent;
	token: string;
}

export interface McpWorld {
	db: D1Database;
	/** May ask `bob` about `schedule`. */
	alice: Participant;
	/** May ask nobody. */
	bob: Participant;
	/** Not allowed to ask or be asked by anyone. */
	carol: Participant;
	schedule: Category;
	health: Category;
}

async function participant(db: D1Database, name: string): Promise<Participant> {
	const agent = await seedAgent(db, { name, description: `${name} knows` });
	const { token } = await issueToken(db, {
		agentId: agent.id,
		purpose: "participant",
		now: T0,
	});
	return { agent, token };
}

export async function createMcpWorld(): Promise<McpWorld> {
	const db = await createTestDb();
	const world: McpWorld = {
		db,
		alice: await participant(db, "alice"),
		bob: await participant(db, "bob"),
		carol: await participant(db, "carol"),
		schedule: await seedCategory(db, { name: "schedule" }),
		health: await seedCategory(db, { name: "health" }),
	};
	await insertAllowRule(db, {
		fromAgentId: world.alice.agent.id,
		toAgentId: world.bob.agent.id,
		categoryId: world.schedule.id,
		createdAt: T0,
	}).run();
	return world;
}

export interface ConnectOptions {
	now?: number;
	env?: McpEnv;
	executionCtx?: Pick<ExecutionContext, "waitUntil">;
}

/** Connects a real MCP client that sends `token` with every request. */
export async function connect(
	token: string | null,
	options: ConnectOptions = {},
): Promise<Client> {
	const client = new Client({ name: "paab-test", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
		fetch: (input, init) =>
			handleMcpRequest(
				new Request(input, init),
				options.env ?? env,
				options.now ?? T0,
				options.executionCtx,
			),
		requestInit:
			token === null ? {} : { headers: { Authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	return client;
}

export interface ToolText {
	text: string;
	isError: boolean;
}

export async function call(
	client: Client,
	name: string,
	args: Record<string, unknown> = {},
): Promise<ToolText> {
	const result = await client.callTool({ name, arguments: args });
	const [first, ...rest] = result.content as { type: string; text: string }[];
	if (first?.type !== "text" || rest.length > 0) {
		throw new Error(`Expected one text block from ${name}`);
	}
	return { text: first.text, isError: result.isError === true };
}

const FOOTER = /\n\nunread_messages: (\d+)$/;

/** The unread count in a tool result's footer. */
export function unreadCount(text: string): number {
	const match = FOOTER.exec(text);
	if (match === null) {
		throw new Error(`No unread footer in:\n${text}`);
	}
	return Number(match[1]);
}

/** A tool result without its unread footer. */
export function withoutFooter(text: string): string {
	unreadCount(text);
	return text.replace(FOOTER, "");
}

/** The question ID an `ask` result reports. */
export function questionIdOf(text: string): string {
	const match = /^question_id: (\S+)$/m.exec(text);
	if (match?.[1] === undefined) {
		throw new Error(`No question ID in:\n${text}`);
	}
	return match[1];
}

export async function askBob(
	client: Client,
	question = "When are you free next week?",
): Promise<string> {
	const result = await call(client, "ask", {
		to: "bob",
		category: "schedule",
		question,
	});
	return questionIdOf(result.text);
}
