import {
	approvePendingDescription,
	getAdminBotConfig,
	listPendingDescriptions,
	rejectPendingDescription,
} from "../../adminbot";
import { adminRedirectResponse, type FlashKind } from "../flash";
import { adminPageResponse } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import { renderDescriptionsPage } from "./render";

const DESCRIPTIONS_PATH = "/admin/descriptions";
const DESCRIPTIONS_TITLE = "説明文";

function redirectDescriptions(
	ctx: AdminPostContext,
	kind: FlashKind,
	message: string,
): Response {
	return adminRedirectResponse(DESCRIPTIONS_PATH, ctx.url, { kind, message });
}

async function handleGetDescriptions(ctx: AdminGetContext): Promise<Response> {
	const db = ctx.env.DB;
	const [pending, config] = await Promise.all([
		listPendingDescriptions(db),
		getAdminBotConfig(db),
	]);

	return adminPageResponse({
		title: DESCRIPTIONS_TITLE,
		currentPath: DESCRIPTIONS_PATH,
		user: ctx.user,
		devMode: ctx.devMode,
		flash: ctx.flash,
		body: renderDescriptionsPage({
			csrfToken: ctx.csrfToken,
			pending,
			adminBotAgentId: config.agentId,
		}),
	});
}

async function handleApproveDescription(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = ctx.params.agentId ?? "";
	const submissionId = ctx.form.get("submission_id") ?? "";
	if (submissionId.trim().length === 0) {
		return redirectDescriptions(ctx, "error", "提出IDを指定してください");
	}
	const result = await approvePendingDescription(ctx.env.DB, {
		agentId,
		expectedSubmissionId: submissionId,
		actor: { actorType: "owner", actorId: ctx.user.email },
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectDescriptions(ctx, "error", result.message);
	}

	return redirectDescriptions(
		ctx,
		"success",
		`エージェント「${result.data.agent.name}」の説明文を承認して公開しました（変更履歴 #${result.changeId}）。`,
	);
}

async function handleRejectDescription(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = ctx.params.agentId ?? "";
	const submissionId = ctx.form.get("submission_id") ?? "";
	if (submissionId.trim().length === 0) {
		return redirectDescriptions(ctx, "error", "提出IDを指定してください");
	}
	const result = await rejectPendingDescription(ctx.env.DB, {
		agentId,
		expectedSubmissionId: submissionId,
		actor: { actorType: "owner", actorId: ctx.user.email },
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectDescriptions(ctx, "error", result.message);
	}

	return redirectDescriptions(
		ctx,
		"success",
		`エージェント「${result.data.agent.name}」の説明文を却下しました（変更履歴 #${result.changeId}）。`,
	);
}

/** Routes for reviewing, approving, and rejecting pending descriptions under `/admin`. */
export function descriptionRoutes(): AdminRoute[] {
	return [
		{ pattern: DESCRIPTIONS_PATH, get: handleGetDescriptions },
		{
			pattern: "/admin/descriptions/:agentId/approve",
			post: handleApproveDescription,
			fallbackPath: DESCRIPTIONS_PATH,
		},
		{
			pattern: "/admin/descriptions/:agentId/reject",
			post: handleRejectDescription,
			fallbackPath: DESCRIPTIONS_PATH,
		},
	];
}
