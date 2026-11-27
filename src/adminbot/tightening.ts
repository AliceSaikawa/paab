import { z } from "zod";
import { revokeAllowRule, suspendAgent, updateAgent } from "../admin";
import { type AgentRow, agentFromRow } from "../db";
import { type Frame, renderFramed } from "../mcp/frame";
import { normalizeName } from "../policy";
import type {
	AdminMcpContext,
	AdminToolAudit,
	AdminToolDefinition,
	AdminToolOutput,
} from "./tools";

function ok(
	text: string,
	audit?: Omit<AdminToolAudit, "deniedReason">,
): AdminToolOutput {
	return audit === undefined
		? { text, isError: false }
		: { text, isError: false, audit };
}

function fail(text: string, audit?: AdminToolAudit): AdminToolOutput {
	return audit === undefined
		? { text, isError: true }
		: { text, isError: true, audit };
}

function validateExactName(
	raw: string,
	field: string,
): { ok: true; value: string } | { ok: false; error: string } {
	if (raw.includes("\0")) {
		return { ok: false, error: `${field} must not contain NUL characters` };
	}
	if (raw.trim().length === 0) {
		return { ok: false, error: `${field} must not be empty` };
	}
	return { ok: true, value: raw };
}

function framedField(label: string, value: string, frame: Frame): string {
	return `${label}:\n${frame(value)}`;
}

function botActor(ctx: AdminMcpContext) {
	return { actorType: "admin_bot" as const, actorId: ctx.agent.id };
}

export const suspendAgentTool: AdminToolDefinition<
	z.ZodObject<{ agent: z.ZodString }>
> = {
	name: "suspend_agent",
	mutating: true,
	description:
		"Immediately suspend an agent by exact name so it cannot send or receive questions or connect to /mcp or /mcp/admin.",
	inputSchema: z.object({
		agent: z.string().describe("Exact name of the agent to suspend."),
	}),
	async run(ctx, args) {
		const nameCheck = validateExactName(args.agent, "agent");
		if (!nameCheck.ok) {
			return fail(nameCheck.error);
		}

		const row = await findAgentByName(ctx.db, nameCheck.value);
		if (row === null) {
			return fail("agent not found");
		}
		const target = agentFromRow(row);

		const result = await suspendAgent(ctx.db, {
			agentId: target.id,
			actor: botActor(ctx),
			now: ctx.now,
		});
		if (!result.ok) {
			return fail(result.message, { toAgentId: target.id });
		}

		return ok(
			renderFramed((frame) =>
				[
					framedField("agent", result.data.agent.name, frame),
					`agent_id: ${result.data.agent.id}`,
					`status: ${result.data.agent.status}`,
					`change_id: ${result.changeId}`,
				].join("\n"),
			),
			{ toAgentId: result.data.agent.id },
		);
	},
};

export const revokeAllowRuleTool: AdminToolDefinition<
	z.ZodObject<{
		from: z.ZodString;
		to: z.ZodString;
		category: z.ZodString;
	}>
> = {
	name: "revoke_allow_rule",
	mutating: true,
	description:
		"Immediately revoke an existing directional allow rule (from -> to for a category) by exact names.",
	inputSchema: z.object({
		from: z.string().describe("Exact name of the asking agent."),
		to: z.string().describe("Exact name of the recipient agent."),
		category: z.string().describe("Exact name of the category."),
	}),
	async run(ctx, args) {
		const fromCheck = validateExactName(args.from, "from");
		if (!fromCheck.ok) return fail(fromCheck.error);
		const toCheck = validateExactName(args.to, "to");
		if (!toCheck.ok) return fail(toCheck.error);
		const catCheck = validateExactName(args.category, "category");
		if (!catCheck.ok) return fail(catCheck.error);

		const [fromResult, toResult, catResult] = await ctx.db.batch([
			dbNameLookup(ctx.db, "agents", fromCheck.value),
			dbNameLookup(ctx.db, "agents", toCheck.value),
			dbNameLookup(ctx.db, "categories", catCheck.value),
		]);

		const fromRow = (fromResult?.results[0] ?? null) as {
			id: string;
			name: string;
		} | null;
		const toRow = (toResult?.results[0] ?? null) as {
			id: string;
			name: string;
		} | null;
		const catRow = (catResult?.results[0] ?? null) as {
			id: string;
			name: string;
		} | null;

		if (fromRow === null) return fail("from agent not found");
		if (toRow === null) return fail("to agent not found");
		if (catRow === null) return fail("category not found");

		const result = await revokeAllowRule(ctx.db, {
			fromAgentId: fromRow.id,
			toAgentId: toRow.id,
			categoryId: catRow.id,
			actor: botActor(ctx),
			now: ctx.now,
		});
		if (!result.ok) {
			return fail(result.message, {
				toAgentId: toRow.id,
				categoryId: catRow.id,
			});
		}

		return ok(
			renderFramed((frame) =>
				[
					framedField("from", fromRow.name, frame),
					framedField("to", toRow.name, frame),
					framedField("category", catRow.name, frame),
					"status: revoked",
					`change_id: ${result.changeId}`,
				].join("\n"),
			),
			{ toAgentId: toRow.id, categoryId: catRow.id },
		);
	},
};

function findAgentByName(
	db: D1Database,
	raw: string,
): Promise<AgentRow | null> {
	return db
		.prepare("SELECT * FROM agents WHERE name = ? OR name = ?")
		.bind(raw, normalizeName(raw))
		.first<AgentRow>();
}

function dbNameLookup(
	db: D1Database,
	table: "agents" | "categories",
	name: string,
): D1PreparedStatement {
	return db
		.prepare(`SELECT id, name FROM ${table} WHERE name = ? OR name = ?`)
		.bind(name, normalizeName(name));
}

export const lowerDailyLimitTool: AdminToolDefinition<
	z.ZodObject<{
		agent: z.ZodString;
		new_limit: z.ZodNumber;
	}>
> = {
	name: "lower_daily_limit",
	mutating: true,
	description:
		"Immediately lower an agent's daily question limit (new_limit must be an integer >= 0 and strictly less than its current limit).",
	inputSchema: z.object({
		agent: z.string().describe("Exact name of the agent."),
		new_limit: z
			.number()
			.int()
			.min(0)
			.describe(
				"New daily question limit (integer >= 0, strictly less than current limit).",
			),
	}),
	async run(ctx, args) {
		const nameCheck = validateExactName(args.agent, "agent");
		if (!nameCheck.ok) {
			return fail(nameCheck.error);
		}
		if (!Number.isSafeInteger(args.new_limit) || args.new_limit < 0) {
			return fail("new_limit must be a non-negative integer");
		}

		const row = await findAgentByName(ctx.db, nameCheck.value);
		if (row === null) {
			return fail("agent not found");
		}
		const target = agentFromRow(row);

		if (args.new_limit >= target.dailyQuestionLimit) {
			return fail(
				`cannot set daily_question_limit to ${args.new_limit}: current limit is ${target.dailyQuestionLimit} and admin_bot can only lower it`,
				{ toAgentId: target.id, deniedReason: "permission_denied" },
			);
		}

		const result = await updateAgent(ctx.db, {
			agentId: target.id,
			dailyQuestionLimit: args.new_limit,
			actor: botActor(ctx),
			now: ctx.now,
		});
		if (!result.ok) {
			return fail(result.message, { toAgentId: target.id });
		}

		return ok(
			renderFramed((frame) =>
				[
					framedField("agent", result.data.agent.name, frame),
					`agent_id: ${result.data.agent.id}`,
					`previous_limit: ${target.dailyQuestionLimit}`,
					`daily_question_limit: ${result.data.agent.dailyQuestionLimit}`,
					`change_id: ${result.changeId}`,
				].join("\n"),
			),
			{ toAgentId: target.id },
		);
	},
};

export const TIGHTENING_TOOLS: readonly AdminToolDefinition[] = [
	suspendAgentTool,
	revokeAllowRuleTool,
	lowerDailyLimitTool,
];
