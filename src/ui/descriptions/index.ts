import type { ChangeActor } from "../../admin";
import { getAdminBotConfig } from "../../adminbot";
import {
	type DescriptionReviewAction,
	type DescriptionReviewErrorCode,
	listPendingDescriptions,
	reviewPendingDescription,
} from "../../adminbot/descriptions";
import { adminPageResponse, type FlashMessage } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import { renderDescriptionsPageBody } from "./render";

const DESCRIPTIONS_PATH = "/admin/descriptions";
const DESCRIPTIONS_TITLE = "説明文";

function ownerActor(ctx: AdminPostContext): ChangeActor {
	return { actorType: "owner", actorId: ctx.user.email };
}

function statusForError(code: DescriptionReviewErrorCode): 400 | 403 | 404 {
	switch (code) {
		case "not_found":
			return 404;
		case "permission_denied":
			return 403;
		case "invalid_input":
			return 400;
	}
}

async function renderDescriptionsScreen(
	ctx: AdminGetContext,
	options: { status?: number; flash?: FlashMessage } = {},
): Promise<Response> {
	const [items, config] = await Promise.all([
		listPendingDescriptions(ctx.env.DB),
		getAdminBotConfig(ctx.env.DB),
	]);

	return adminPageResponse(
		{
			title: DESCRIPTIONS_TITLE,
			currentPath: DESCRIPTIONS_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: options.flash,
			body: renderDescriptionsPageBody({
				items,
				adminBotAgentId: config.agentId,
				csrfToken: ctx.csrfToken,
			}),
		},
		options.status ?? 200,
	);
}

async function handleGetDescriptions(ctx: AdminGetContext): Promise<Response> {
	return renderDescriptionsScreen(ctx);
}

async function handleReviewDescription(
	ctx: AdminPostContext,
	action: DescriptionReviewAction,
): Promise<Response> {
	const agentId = ctx.params.agentId ?? "";
	const result = await reviewPendingDescription(ctx.env.DB, {
		agentId,
		action,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderDescriptionsScreen(ctx, {
			status: statusForError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	const message =
		action === "approve"
			? `「${result.data.agent.name}」の説明文を承認しました`
			: `「${result.data.agent.name}」の説明文の提案を却下しました`;

	return renderDescriptionsScreen(ctx, {
		flash: { kind: "success", message },
	});
}

/** Admin UI routes for reviewing pending agent descriptions (`/admin/descriptions`). */
export function descriptionRoutes(): AdminRoute[] {
	return [
		{ pattern: DESCRIPTIONS_PATH, get: handleGetDescriptions },
		{
			pattern: "/admin/descriptions/:agentId/approve",
			post: (ctx) => handleReviewDescription(ctx, "approve"),
		},
		{
			pattern: "/admin/descriptions/:agentId/reject",
			post: (ctx) => handleReviewDescription(ctx, "reject"),
		},
	];
}
