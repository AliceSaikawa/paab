import {
	approveProposal,
	describeProposalEffect,
	listProposals,
	type ProposalErrorCode,
	rejectProposal,
} from "../../adminbot";
import { adminPageResponse, type FlashMessage } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import { renderProposalsPageBody } from "./render";

const PROPOSALS_PATH = "/admin/proposals";
const PROPOSALS_TITLE = "提案";

function statusForError(code: ProposalErrorCode): 400 | 404 | 409 {
	switch (code) {
		case "not_found":
			return 404;
		case "invalid_input":
		case "invalid_name":
		case "invalid_payload":
			return 400;
		case "invalid_limit":
		case "self_addressed":
		case "duplicate_rule":
		case "duplicate_name":
		case "already_active":
		case "too_many_pending":
		case "already_resolved":
		case "expired":
		case "conflict":
			return 409;
	}
}

async function renderProposalsScreen(
	ctx: AdminGetContext,
	options: { status?: number; flash?: FlashMessage } = {},
): Promise<Response> {
	const [pending, recentRows] = await Promise.all([
		listProposals(ctx.env.DB, { status: "pending", now: ctx.now, limit: 100 }),
		listProposals(ctx.env.DB, { now: ctx.now, limit: 50 }),
	]);

	const recent = recentRows.filter((row) => row.status !== "pending");

	return adminPageResponse(
		{
			title: PROPOSALS_TITLE,
			currentPath: PROPOSALS_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: options.flash,
			body: renderProposalsPageBody({
				csrfToken: ctx.csrfToken,
				now: ctx.now,
				pending,
				recent,
			}),
		},
		options.status ?? 200,
	);
}

async function handleGetProposals(ctx: AdminGetContext): Promise<Response> {
	return renderProposalsScreen(ctx);
}

async function handleApproveProposal(ctx: AdminPostContext): Promise<Response> {
	const result = await approveProposal(ctx.env.DB, {
		proposalId: ctx.params.id ?? "",
		approverEmail: ctx.user.email,
		now: ctx.now,
	});
	if (!result.ok) {
		return renderProposalsScreen(ctx, {
			status: statusForError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderProposalsScreen(ctx, {
		flash: {
			kind: "success",
			message: `提案を承認して反映しました: ${describeProposalEffect(result.data.proposal)}`,
		},
	});
}

async function handleRejectProposal(ctx: AdminPostContext): Promise<Response> {
	const result = await rejectProposal(ctx.env.DB, {
		proposalId: ctx.params.id ?? "",
		approverEmail: ctx.user.email,
		now: ctx.now,
	});
	if (!result.ok) {
		return renderProposalsScreen(ctx, {
			status: statusForError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderProposalsScreen(ctx, {
		flash: {
			kind: "success",
			message: `提案を却下しました: ${describeProposalEffect(result.data.proposal)}`,
		},
	});
}

/** Admin UI routes for reviewing, approving, and rejecting admin bot proposals. */
export function proposalRoutes(): AdminRoute[] {
	return [
		{ pattern: PROPOSALS_PATH, get: handleGetProposals },
		{ pattern: "/admin/proposals/:id/approve", post: handleApproveProposal },
		{ pattern: "/admin/proposals/:id/reject", post: handleRejectProposal },
	];
}
