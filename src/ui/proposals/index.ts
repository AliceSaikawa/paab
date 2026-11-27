import {
	listAgentsWithStatus,
	listCategoriesWithUsage,
	queryChangeLog,
} from "../../admin";
import {
	approveProposal,
	listProposals,
	MAX_PROPOSAL_LIST_LIMIT,
	type ProposalErrorCode,
	rejectProposal,
} from "../../adminbot";
import { adminPageResponse, type FlashMessage } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import { renderProposalsPage } from "./render";

const PROPOSALS_PATH = "/admin/proposals";
const PROPOSALS_TITLE = "提案";

function statusForProposalError(code: ProposalErrorCode): 400 | 404 | 409 {
	switch (code) {
		case "not_found":
			return 404;
		case "already_resolved":
		case "expired":
		case "premise_changed":
		case "not_admin_bot":
		case "pending_limit_reached":
		case "duplicate_name":
		case "duplicate_rule":
			return 409;
		case "invalid_input":
		case "invalid_name":
		case "invalid_limit":
		case "invalid_reason":
		case "self_addressed":
		case "already_active":
		case "limit_not_raised":
			return 400;
	}
}

async function renderProposalsScreen(
	ctx: AdminGetContext,
	options: { status?: number; flash?: FlashMessage } = {},
): Promise<Response> {
	const db = ctx.env.DB;
	const [pending, allProposals, agents, categories, changeLog] =
		await Promise.all([
			listProposals(db, {
				status: "pending",
				limit: MAX_PROPOSAL_LIST_LIMIT,
				now: ctx.now,
			}),
			listProposals(db, {
				limit: MAX_PROPOSAL_LIST_LIMIT,
				now: ctx.now,
			}),
			listAgentsWithStatus(db, ctx.now),
			listCategoriesWithUsage(db),
			queryChangeLog(db),
		]);

	const history = allProposals.filter(
		(proposal) => proposal.status !== "pending",
	);

	return adminPageResponse(
		{
			title: PROPOSALS_TITLE,
			currentPath: PROPOSALS_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: options.flash,
			body: renderProposalsPage({
				csrfToken: ctx.csrfToken,
				pending,
				history,
				agents,
				categories,
				changeLog,
			}),
		},
		options.status ?? 200,
	);
}

async function handleGetProposals(ctx: AdminGetContext): Promise<Response> {
	return renderProposalsScreen(ctx);
}

async function handleApproveProposal(ctx: AdminPostContext): Promise<Response> {
	const proposalId = ctx.params.id ?? "";
	const result = await approveProposal(ctx.env.DB, {
		proposalId,
		approverId: ctx.user.email,
		now: ctx.now,
	});
	if (!result.ok) {
		return renderProposalsScreen(ctx, {
			status: statusForProposalError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderProposalsScreen(ctx, {
		flash: {
			kind: "success",
			message: `提案を承認し、変更を反映しました（変更履歴 #${result.data.changeId}）。`,
		},
	});
}

async function handleRejectProposal(ctx: AdminPostContext): Promise<Response> {
	const proposalId = ctx.params.id ?? "";
	const result = await rejectProposal(ctx.env.DB, {
		proposalId,
		approverId: ctx.user.email,
		now: ctx.now,
	});
	if (!result.ok) {
		return renderProposalsScreen(ctx, {
			status: statusForProposalError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderProposalsScreen(ctx, {
		flash: {
			kind: "success",
			message: "提案を却下しました。",
		},
	});
}

/** Routes for reviewing, approving, and rejecting admin bot proposals under `/admin`. */
export function proposalRoutes(): AdminRoute[] {
	return [
		{ pattern: PROPOSALS_PATH, get: handleGetProposals },
		{ pattern: "/admin/proposals/:id/approve", post: handleApproveProposal },
		{ pattern: "/admin/proposals/:id/reject", post: handleRejectProposal },
	];
}
