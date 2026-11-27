import {
	approvePendingDescription,
	type DescriptionErrorCode,
	getAdminBotConfig,
	listPendingDescriptions,
	rejectPendingDescription,
} from "../../adminbot";
import { adminPageResponse, type FlashMessage } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import { renderDescriptionsPage } from "./render";

const DESCRIPTIONS_PATH = "/admin/descriptions";
const DESCRIPTIONS_TITLE = "説明文";

function statusForDescriptionError(
	code: DescriptionErrorCode,
): 400 | 403 | 404 | 409 {
	switch (code) {
		case "not_found":
			return 404;
		case "self_approval_forbidden":
			return 403;
		case "submission_changed":
			return 409;
		default:
			return 400;
	}
}

async function renderDescriptionsScreen(
	ctx: AdminGetContext,
	options: { status?: number; flash?: FlashMessage } = {},
): Promise<Response> {
	const db = ctx.env.DB;
	const [pending, config] = await Promise.all([
		listPendingDescriptions(db),
		getAdminBotConfig(db),
	]);

	return adminPageResponse(
		{
			title: DESCRIPTIONS_TITLE,
			currentPath: DESCRIPTIONS_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: options.flash,
			body: renderDescriptionsPage({
				csrfToken: ctx.csrfToken,
				pending,
				adminBotAgentId: config.agentId,
			}),
		},
		options.status ?? 200,
	);
}

async function handleGetDescriptions(ctx: AdminGetContext): Promise<Response> {
	return renderDescriptionsScreen(ctx);
}

async function handleApproveDescription(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = ctx.params.agentId ?? "";
	const submissionId = ctx.form.get("submission_id") ?? "";
	if (submissionId.trim().length === 0) {
		return renderDescriptionsScreen(ctx, {
			status: 400,
			flash: { kind: "error", message: "提出IDを指定してください" },
		});
	}
	const result = await approvePendingDescription(ctx.env.DB, {
		agentId,
		expectedSubmissionId: submissionId,
		actor: { actorType: "owner", actorId: ctx.user.email },
		now: ctx.now,
	});
	if (!result.ok) {
		return renderDescriptionsScreen(ctx, {
			status: statusForDescriptionError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderDescriptionsScreen(ctx, {
		flash: {
			kind: "success",
			message: `エージェント「${result.data.agent.name}」の説明文を承認して公開しました（変更履歴 #${result.changeId}）。`,
		},
	});
}

async function handleRejectDescription(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = ctx.params.agentId ?? "";
	const submissionId = ctx.form.get("submission_id") ?? "";
	if (submissionId.trim().length === 0) {
		return renderDescriptionsScreen(ctx, {
			status: 400,
			flash: { kind: "error", message: "提出IDを指定してください" },
		});
	}
	const result = await rejectPendingDescription(ctx.env.DB, {
		agentId,
		expectedSubmissionId: submissionId,
		actor: { actorType: "owner", actorId: ctx.user.email },
		now: ctx.now,
	});
	if (!result.ok) {
		return renderDescriptionsScreen(ctx, {
			status: statusForDescriptionError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderDescriptionsScreen(ctx, {
		flash: {
			kind: "success",
			message: `エージェント「${result.data.agent.name}」の説明文を却下しました（変更履歴 #${result.changeId}）。`,
		},
	});
}

/** Routes for reviewing, approving, and rejecting pending descriptions under `/admin`. */
export function descriptionRoutes(): AdminRoute[] {
	return [
		{ pattern: DESCRIPTIONS_PATH, get: handleGetDescriptions },
		{
			pattern: "/admin/descriptions/:agentId/approve",
			post: handleApproveDescription,
		},
		{
			pattern: "/admin/descriptions/:agentId/reject",
			post: handleRejectDescription,
		},
	];
}
