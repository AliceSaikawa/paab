import {
	listAgentsWithStatus,
	listCategoriesWithUsage,
	queryChangeLog,
} from "../../admin";
import {
	approveProposal,
	listProposals,
	MAX_PROPOSAL_LIST_LIMIT,
	rejectProposal,
} from "../../adminbot";
import { adminRedirectResponse, type FlashKind } from "../flash";
import { adminPageResponse } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import { renderProposalsPage } from "./render";

const PROPOSALS_PATH = "/admin/proposals";
const PROPOSALS_TITLE = "提案";

function redirectProposals(
	ctx: AdminPostContext,
	kind: FlashKind,
	message: string,
): Response {
	return adminRedirectResponse(PROPOSALS_PATH, ctx.url, { kind, message });
}

async function handleGetProposals(ctx: AdminGetContext): Promise<Response> {
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

	return adminPageResponse({
		title: PROPOSALS_TITLE,
		currentPath: PROPOSALS_PATH,
		user: ctx.user,
		devMode: ctx.devMode,
		flash: ctx.flash,
		body: renderProposalsPage({
			csrfToken: ctx.csrfToken,
			pending,
			history,
			agents,
			categories,
			changeLog,
		}),
	});
}

async function handleApproveProposal(ctx: AdminPostContext): Promise<Response> {
	const proposalId = ctx.params.id ?? "";
	const result = await approveProposal(ctx.env.DB, {
		proposalId,
		approverId: ctx.user.email,
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectProposals(ctx, "error", result.message);
	}

	return redirectProposals(
		ctx,
		"success",
		`提案を承認し、変更を反映しました（変更履歴 #${result.data.changeId}）。`,
	);
}

async function handleRejectProposal(ctx: AdminPostContext): Promise<Response> {
	const proposalId = ctx.params.id ?? "";
	const result = await rejectProposal(ctx.env.DB, {
		proposalId,
		approverId: ctx.user.email,
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectProposals(ctx, "error", result.message);
	}

	return redirectProposals(ctx, "success", "提案を却下しました。");
}

/** Routes for reviewing, approving, and rejecting admin bot proposals under `/admin`. */
export function proposalRoutes(): AdminRoute[] {
	return [
		{ pattern: PROPOSALS_PATH, get: handleGetProposals },
		{
			pattern: "/admin/proposals/:id/approve",
			post: handleApproveProposal,
			fallbackPath: PROPOSALS_PATH,
		},
		{
			pattern: "/admin/proposals/:id/reject",
			post: handleRejectProposal,
			fallbackPath: PROPOSALS_PATH,
		},
	];
}
