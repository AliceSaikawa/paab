import { z } from "zod";
import { type AgentRow, agentFromRow } from "../db";
import { type Frame, renderFramed } from "../mcp/frame";
import {
	descriptionProblem,
	nameProblem,
	normalizeDescription,
	normalizeName,
} from "../policy";
import {
	type Agent,
	PROPOSAL_STATUSES,
	type Proposal,
	type ProposalPayload,
} from "../types";
import {
	createProposal,
	DEFAULT_PROPOSAL_LIST_LIMIT,
	listProposals,
	MAX_PROPOSAL_LIST_LIMIT,
	PROPOSAL_REASON_MAX_LENGTH,
} from "./proposals";
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

function framedField(label: string, value: string, frame: Frame): string {
	return `${label}:\n${frame(value)}`;
}

function framedOptionalField(
	label: string,
	value: string | null | undefined,
	frame: Frame,
): string {
	if (value === null || value === undefined) {
		return `${label}: -`;
	}
	return framedField(label, value, frame);
}

/** Validates a proposal's `reason` argument before submission. */
export function validateProposalReasonArg(
	raw: string,
): { ok: true; reason: string } | { ok: false; error: string } {
	if (raw.includes("\0")) {
		return { ok: false, error: "reason must not contain NUL characters" };
	}
	const trimmed = normalizeDescription(raw).trim();
	if (trimmed.length === 0) {
		return { ok: false, error: "reason must not be empty" };
	}
	if (trimmed.length > PROPOSAL_REASON_MAX_LENGTH) {
		return {
			ok: false,
			error: `reason must be at most ${PROPOSAL_REASON_MAX_LENGTH} characters`,
		};
	}
	const problem = descriptionProblem(trimmed);
	if (problem !== null) {
		return { ok: false, error: problem };
	}
	return { ok: true, reason: trimmed };
}

export interface ResolvedAllowRuleTargets {
	from: { id: string; name: string };
	to: { id: string; name: string };
	category: { id: string; name: string };
}

/** Resolves and validates `(from, to, category)` names for allow-rule operations. */
export async function resolveAllowRuleTargets(
	db: D1Database,
	args: { from: string; to: string; category: string },
): Promise<
	{ ok: true; targets: ResolvedAllowRuleTargets } | { ok: false; error: string }
> {
	const fromCheck = validateExactName(args.from, "from");
	if (!fromCheck.ok) return fromCheck;
	const toCheck = validateExactName(args.to, "to");
	if (!toCheck.ok) return toCheck;
	const catCheck = validateExactName(args.category, "category");
	if (!catCheck.ok) return catCheck;

	const [fromResult, toResult, catResult] = await db.batch([
		dbNameLookup(db, "agents", fromCheck.value),
		dbNameLookup(db, "agents", toCheck.value),
		dbNameLookup(db, "categories", catCheck.value),
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

	if (fromRow === null) return { ok: false, error: "from agent not found" };
	if (toRow === null) return { ok: false, error: "to agent not found" };
	if (catRow === null) return { ok: false, error: "category not found" };
	if (fromRow.id === toRow.id) {
		return {
			ok: false,
			error: "cannot allow an agent to ask itself",
		};
	}

	return {
		ok: true,
		targets: { from: fromRow, to: toRow, category: catRow },
	};
}

/** Validates and normalizes a category name argument. */
export function validateCategoryNameArg(
	raw: string,
): { ok: true; name: string } | { ok: false; error: string } {
	if (raw.includes("\0")) {
		return { ok: false, error: "name must not contain NUL characters" };
	}
	const problem = nameProblem(raw);
	if (problem !== null) {
		return { ok: false, error: problem };
	}
	return { ok: true, name: normalizeName(raw) };
}

/** Resolves and validates `(agent, new_limit)` for raising a daily limit. */
export async function resolveRaiseLimitTarget(
	db: D1Database,
	args: { agent: string; new_limit: number },
): Promise<
	| { ok: true; agent: Agent; newLimit: number }
	| { ok: false; error: string; audit?: AdminToolAudit }
> {
	const nameCheck = validateExactName(args.agent, "agent");
	if (!nameCheck.ok) return nameCheck;
	if (!Number.isSafeInteger(args.new_limit) || args.new_limit < 0) {
		return { ok: false, error: "new_limit must be a non-negative integer" };
	}

	const row = await findAgentByName(db, nameCheck.value);
	if (row === null) {
		return { ok: false, error: "agent not found" };
	}
	const agent = agentFromRow(row);
	if (args.new_limit <= agent.dailyQuestionLimit) {
		return {
			ok: false,
			error: `new_limit (${args.new_limit}) must be strictly greater than current daily_question_limit (${agent.dailyQuestionLimit})`,
			audit: { toAgentId: agent.id },
		};
	}
	return { ok: true, agent, newLimit: args.new_limit };
}

/** Resolves and validates a suspended target agent for resuming. */
export async function resolveResumeAgentTarget(
	db: D1Database,
	args: { agent: string },
): Promise<
	| { ok: true; agent: Agent }
	| { ok: false; error: string; audit?: AdminToolAudit }
> {
	const nameCheck = validateExactName(args.agent, "agent");
	if (!nameCheck.ok) return nameCheck;

	const row = await findAgentByName(db, nameCheck.value);
	if (row === null) {
		return { ok: false, error: "agent not found" };
	}
	const agent = agentFromRow(row);
	if (agent.status !== "suspended") {
		return {
			ok: false,
			error: "agent is already active",
			audit: { toAgentId: agent.id },
		};
	}
	return { ok: true, agent };
}

async function submitProposal(
	ctx: AdminMcpContext,
	payload: ProposalPayload,
	reason: string,
	renderTargetLines: (frame: Frame) => string[],
	audit?: Omit<AdminToolAudit, "deniedReason">,
): Promise<AdminToolOutput> {
	const result = await createProposal(ctx.db, {
		proposerAgentId: ctx.agent.id,
		payload,
		reason,
		now: ctx.now,
	});
	if (!result.ok) {
		return fail(result.message, audit);
	}
	const { proposal } = result.data;
	return ok(
		renderFramed((frame) =>
			[
				`proposal_id: ${proposal.id}`,
				`kind: ${proposal.kind}`,
				`status: ${proposal.status}`,
				`expires_at: ${new Date(proposal.expiresAt).toISOString()}`,
				...renderTargetLines(frame),
				framedField("reason", proposal.reason, frame),
			].join("\n"),
		),
		audit,
	);
}

export const proposeAllowRuleTool: AdminToolDefinition<
	z.ZodObject<{
		from: z.ZodString;
		to: z.ZodString;
		category: z.ZodString;
		reason: z.ZodString;
	}>
> = {
	name: "propose_allow_rule",
	description:
		"Submit a proposal to grant a directional allow rule (from -> to for a category). Does not take effect until the owner approves it in the Admin UI.",
	inputSchema: z.object({
		from: z.string().describe("Exact name of the asking agent."),
		to: z.string().describe("Exact name of the recipient agent."),
		category: z.string().describe("Exact name of the category."),
		reason: z
			.string()
			.describe(
				`Non-empty explanation shown to the owner (up to ${PROPOSAL_REASON_MAX_LENGTH} characters).`,
			),
	}),
	async run(ctx, args) {
		const reasonCheck = validateProposalReasonArg(args.reason);
		if (!reasonCheck.ok) return fail(reasonCheck.error);

		const resolved = await resolveAllowRuleTargets(ctx.db, args);
		if (!resolved.ok) return fail(resolved.error);
		const { from, to, category } = resolved.targets;

		return submitProposal(
			ctx,
			{
				kind: "grant_allow_rule",
				fromAgentId: from.id,
				toAgentId: to.id,
				categoryId: category.id,
			},
			reasonCheck.reason,
			(frame) => [
				`from_id: ${from.id}`,
				framedField("from", from.name, frame),
				`to_id: ${to.id}`,
				framedField("to", to.name, frame),
				`category_id: ${category.id}`,
				framedField("category", category.name, frame),
			],
			{ toAgentId: to.id, categoryId: category.id },
		);
	},
};

export const proposeCategoryTool: AdminToolDefinition<
	z.ZodObject<{
		name: z.ZodString;
		reason: z.ZodString;
	}>
> = {
	name: "propose_category",
	description:
		"Submit a proposal to create a new question category. Does not take effect until the owner approves it in the Admin UI.",
	inputSchema: z.object({
		name: z.string().describe("Name of the new category (1-64 characters)."),
		reason: z
			.string()
			.describe(
				`Non-empty explanation shown to the owner (up to ${PROPOSAL_REASON_MAX_LENGTH} characters).`,
			),
	}),
	async run(ctx, args) {
		const reasonCheck = validateProposalReasonArg(args.reason);
		if (!reasonCheck.ok) return fail(reasonCheck.error);

		const nameCheck = validateCategoryNameArg(args.name);
		if (!nameCheck.ok) return fail(nameCheck.error);

		return submitProposal(
			ctx,
			{ kind: "create_category", name: nameCheck.name },
			reasonCheck.reason,
			(frame) => [framedField("category", nameCheck.name, frame)],
		);
	},
};

export const proposeRaiseDailyLimitTool: AdminToolDefinition<
	z.ZodObject<{
		agent: z.ZodString;
		new_limit: z.ZodNumber;
		reason: z.ZodString;
	}>
> = {
	name: "propose_raise_daily_limit",
	description:
		"Submit a proposal to raise an agent's daily question limit (new_limit must be strictly greater than its current limit). Does not take effect until the owner approves it in the Admin UI.",
	inputSchema: z.object({
		agent: z.string().describe("Exact name of the agent."),
		new_limit: z
			.number()
			.int()
			.min(1)
			.describe(
				"Proposed daily question limit (integer strictly greater than current limit).",
			),
		reason: z
			.string()
			.describe(
				`Non-empty explanation shown to the owner (up to ${PROPOSAL_REASON_MAX_LENGTH} characters).`,
			),
	}),
	async run(ctx, args) {
		const reasonCheck = validateProposalReasonArg(args.reason);
		if (!reasonCheck.ok) return fail(reasonCheck.error);

		const resolved = await resolveRaiseLimitTarget(ctx.db, args);
		if (!resolved.ok) return fail(resolved.error, resolved.audit);
		const { agent, newLimit } = resolved;

		return submitProposal(
			ctx,
			{ kind: "raise_daily_limit", agentId: agent.id, newLimit },
			reasonCheck.reason,
			(frame) => [
				`agent_id: ${agent.id}`,
				framedField("agent", agent.name, frame),
				`current_limit: ${agent.dailyQuestionLimit}`,
				`proposed_limit: ${newLimit}`,
			],
			{ toAgentId: agent.id },
		);
	},
};

export const proposeResumeAgentTool: AdminToolDefinition<
	z.ZodObject<{
		agent: z.ZodString;
		reason: z.ZodString;
	}>
> = {
	name: "propose_resume_agent",
	description:
		"Submit a proposal to resume a suspended agent. Does not take effect until the owner approves it in the Admin UI.",
	inputSchema: z.object({
		agent: z.string().describe("Exact name of the suspended agent."),
		reason: z
			.string()
			.describe(
				`Non-empty explanation shown to the owner (up to ${PROPOSAL_REASON_MAX_LENGTH} characters).`,
			),
	}),
	async run(ctx, args) {
		const reasonCheck = validateProposalReasonArg(args.reason);
		if (!reasonCheck.ok) return fail(reasonCheck.error);

		const resolved = await resolveResumeAgentTarget(ctx.db, args);
		if (!resolved.ok) return fail(resolved.error, resolved.audit);
		const { agent } = resolved;

		return submitProposal(
			ctx,
			{ kind: "resume_agent", agentId: agent.id },
			reasonCheck.reason,
			(frame) => [
				`agent_id: ${agent.id}`,
				framedField("agent", agent.name, frame),
			],
			{ toAgentId: agent.id },
		);
	},
};

function renderProposalEntry(
	proposal: Proposal,
	names: { agents: Map<string, string>; categories: Map<string, string> },
	frame: Frame,
): string {
	const lines = [
		`id: ${proposal.id}`,
		`kind: ${proposal.kind}`,
		`status: ${proposal.status}`,
		`created_at: ${new Date(proposal.createdAt).toISOString()}`,
		`expires_at: ${new Date(proposal.expiresAt).toISOString()}`,
		`resolved_at: ${proposal.resolvedAt !== null ? new Date(proposal.resolvedAt).toISOString() : "-"}`,
		`change_log_id: ${proposal.changeLogId ?? "-"}`,
	];

	const { payload } = proposal;
	switch (payload.kind) {
		case "grant_allow_rule":
			lines.push(
				`from_id: ${payload.fromAgentId}`,
				framedOptionalField(
					"from_name",
					names.agents.get(payload.fromAgentId),
					frame,
				),
				`to_id: ${payload.toAgentId}`,
				framedOptionalField(
					"to_name",
					names.agents.get(payload.toAgentId),
					frame,
				),
				`category_id: ${payload.categoryId}`,
				framedOptionalField(
					"category_name",
					names.categories.get(payload.categoryId),
					frame,
				),
			);
			break;
		case "create_category":
			lines.push(framedField("category_name", payload.name, frame));
			break;
		case "raise_daily_limit":
			lines.push(
				`agent_id: ${payload.agentId}`,
				framedOptionalField(
					"agent_name",
					names.agents.get(payload.agentId),
					frame,
				),
				`new_limit: ${payload.newLimit}`,
			);
			break;
		case "resume_agent":
			lines.push(
				`agent_id: ${payload.agentId}`,
				framedOptionalField(
					"agent_name",
					names.agents.get(payload.agentId),
					frame,
				),
			);
			break;
	}

	lines.push(framedField("reason", proposal.reason, frame));
	return lines.join("\n");
}

const listProposalsInputSchema = z.object({
	status: z
		.enum(PROPOSAL_STATUSES)
		.optional()
		.describe("Optional status filter: pending, approved, rejected, expired."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_PROPOSAL_LIST_LIMIT)
		.optional()
		.describe(
			`Maximum proposals to return (1-${MAX_PROPOSAL_LIST_LIMIT}, default ${DEFAULT_PROPOSAL_LIST_LIMIT}).`,
		),
});

export const listProposalsTool: AdminToolDefinition<
	typeof listProposalsInputSchema
> = {
	name: "list_proposals",
	description:
		"List proposals submitted by this admin bot with optional status filter (pending, approved, rejected, expired).",
	inputSchema: listProposalsInputSchema,
	async run(ctx, args) {
		const proposals = await listProposals(ctx.db, {
			status: args.status,
			proposerAgentId: ctx.agent.id,
			limit: args.limit,
			now: ctx.now,
		});
		if (proposals.length === 0) {
			return ok("no matching proposals");
		}

		const [agentsRes, categoriesRes] = await ctx.db.batch([
			ctx.db.prepare("SELECT id, name FROM agents"),
			ctx.db.prepare("SELECT id, name FROM categories"),
		]);
		const agentNames = new Map<string, string>();
		for (const row of (agentsRes?.results ?? []) as {
			id: string;
			name: string;
		}[]) {
			agentNames.set(row.id, row.name);
		}
		const categoryNames = new Map<string, string>();
		for (const row of (categoriesRes?.results ?? []) as {
			id: string;
			name: string;
		}[]) {
			categoryNames.set(row.id, row.name);
		}

		return ok(
			renderFramed((frame) => {
				const header = `proposals: ${proposals.length}`;
				return [
					header,
					...proposals.map((proposal) =>
						renderProposalEntry(
							proposal,
							{ agents: agentNames, categories: categoryNames },
							frame,
						),
					),
				].join("\n\n");
			}),
		);
	},
};

export const PROPOSAL_TOOLS: readonly AdminToolDefinition[] = [
	proposeAllowRuleTool,
	proposeCategoryTool,
	proposeRaiseDailyLimitTool,
	proposeResumeAgentTool,
	listProposalsTool,
];
