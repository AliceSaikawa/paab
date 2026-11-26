import { z } from "zod";
import { type Frame, renderFramed } from "../mcp/frame";
import { PROPOSAL_STATUSES } from "../types";
import {
	createProposal,
	describeProposalEffect,
	listProposals,
	type ProposalRequest,
	type ProposalView,
} from "./proposals";
import {
	type AdminMcpContext,
	type AdminToolDefinition,
	type AdminToolOutput,
	adminToolFail,
	adminToolOk,
	defineAdminTool,
} from "./tools";

async function submitProposal(
	ctx: AdminMcpContext,
	request: ProposalRequest,
	reason: string,
): Promise<AdminToolOutput> {
	const result = await createProposal(ctx.db, {
		botAgentId: ctx.agent.id,
		request,
		reason,
		now: ctx.now,
	});
	if (!result.ok) {
		return adminToolFail(result.message);
	}
	const { proposal } = result.data;
	const effect = describeProposalEffect(proposal);
	return adminToolOk(
		renderFramed((frame) =>
			[
				`proposal_id: ${proposal.id}`,
				`kind: ${proposal.kind}`,
				`status: ${proposal.status}`,
				`expires_at: ${new Date(proposal.expiresAt).toISOString()}`,
				`effect:\n${frame(effect)}`,
			].join("\n"),
		),
		{ messageId: proposal.id },
	);
}

const proposeAllowRule = defineAdminTool({
	name: "propose_allow_rule",
	description:
		"Propose granting a directional allow rule (from -> to for a category). Does not take effect until the human owner approves it in /admin/proposals.",
	inputSchema: z.object({
		from: z.string().describe("Asking agent name."),
		to: z.string().describe("Recipient agent name."),
		category: z.string().describe("Category name."),
		reason: z.string().describe("Why this allow rule is needed."),
	}),
	async run(ctx, args) {
		return submitProposal(
			ctx,
			{
				kind: "grant_allow_rule",
				fromAgentName: args.from,
				toAgentName: args.to,
				categoryName: args.category,
			},
			args.reason,
		);
	},
});

const proposeCategory = defineAdminTool({
	name: "propose_category",
	description:
		"Propose adding a new question category. Does not take effect until the human owner approves it in /admin/proposals.",
	inputSchema: z.object({
		name: z.string().describe("New category name (1-64 characters)."),
		reason: z.string().describe("Why this category is needed."),
	}),
	async run(ctx, args) {
		return submitProposal(
			ctx,
			{
				kind: "create_category",
				name: args.name,
			},
			args.reason,
		);
	},
});

const proposeDailyLimitRaise = defineAdminTool({
	name: "propose_daily_limit_raise",
	description:
		"Propose raising an agent's daily question limit above its current value. Does not take effect until the human owner approves it in /admin/proposals.",
	inputSchema: z.object({
		agent: z.string().describe("Target agent name."),
		new_limit: z
			.number()
			.int()
			.describe("Proposed new daily limit (must exceed the current limit)."),
		reason: z.string().describe("Why the limit increase is needed."),
	}),
	async run(ctx, args) {
		return submitProposal(
			ctx,
			{
				kind: "raise_daily_limit",
				agentName: args.agent,
				newLimit: args.new_limit,
			},
			args.reason,
		);
	},
});

const proposeResumeAgent = defineAdminTool({
	name: "propose_resume_agent",
	description:
		"Propose resuming a currently suspended agent. Does not take effect until the human owner approves it in /admin/proposals.",
	inputSchema: z.object({
		agent: z.string().describe("Suspended agent name."),
		reason: z.string().describe("Why the agent should be resumed."),
	}),
	async run(ctx, args) {
		return submitProposal(
			ctx,
			{
				kind: "resume_agent",
				agentName: args.agent,
			},
			args.reason,
		);
	},
});

function renderProposalEntry(proposal: ProposalView, frame: Frame): string {
	return [
		`id: ${proposal.id}`,
		`kind: ${proposal.kind}`,
		`status: ${proposal.status}`,
		`created_at: ${new Date(proposal.createdAt).toISOString()}`,
		`expires_at: ${new Date(proposal.expiresAt).toISOString()}`,
		`resolved_at: ${proposal.resolvedAt !== null ? new Date(proposal.resolvedAt).toISOString() : "-"}`,
		`resolved_by: ${proposal.resolvedBy ?? "-"}`,
		`effect:\n${frame(describeProposalEffect(proposal))}`,
		`reason:\n${frame(proposal.reason)}`,
	].join("\n");
}

const listProposalsTool = defineAdminTool({
	name: "list_proposals",
	description:
		"List admin bot proposals with their mechanical change summary and framed reason text, optionally filtered by status.",
	inputSchema: z.object({
		status: z
			.enum(PROPOSAL_STATUSES)
			.optional()
			.describe("Optional filter: pending, approved, rejected, or expired."),
	}),
	async run(ctx, args) {
		const proposals = await listProposals(ctx.db, {
			status: args.status,
			now: ctx.now,
		});
		if (proposals.length === 0) {
			return adminToolOk("no matching proposals");
		}
		return adminToolOk(
			renderFramed((frame) =>
				[
					`proposals: ${proposals.length}`,
					...proposals.map((entry) => renderProposalEntry(entry, frame)),
				].join("\n\n"),
			),
		);
	},
});

export const PROPOSAL_ADMIN_TOOLS: readonly AdminToolDefinition[] = [
	proposeAllowRule,
	proposeCategory,
	proposeDailyLimitRaise,
	proposeResumeAgent,
	listProposalsTool,
];
