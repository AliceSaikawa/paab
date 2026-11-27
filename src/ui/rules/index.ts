import {
	type AdminErrorCode,
	createCategory,
	deleteCategory,
	grantAllowRule,
	listAgentsWithStatus,
	listAllowRulesGrouped,
	listCategoriesWithUsage,
	queryChangeLog,
	revokeAllowRule,
} from "../../admin";
import { adminPageResponse, type FlashMessage } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import {
	type RulesPageFormValues,
	renderCategoryNotFoundPage,
	renderDeleteCategoryPage,
	renderRulesPage,
} from "./render";

const RULES_PATH = "/admin/rules";
const RULES_TITLE = "ルール・カテゴリ";

function statusForAdminError(code: AdminErrorCode): number {
	switch (code) {
		case "not_found":
			return 404;
		case "duplicate_name":
		case "duplicate_rule":
			return 409;
		case "invalid_name":
		case "invalid_description":
		case "invalid_limit":
		case "invalid_input":
		case "already_suspended":
		case "already_active":
		case "self_addressed":
			return 400;
	}
}

function ownerActor(ctx: AdminGetContext) {
	return { actorType: "owner" as const, actorId: ctx.user.email };
}

async function renderRulesScreen(
	ctx: AdminGetContext,
	options: {
		status?: number;
		flash?: FlashMessage;
		formValues?: RulesPageFormValues;
	} = {},
): Promise<Response> {
	const db = ctx.env.DB;
	const [ruleGroups, agents, categories, changeLog] = await Promise.all([
		listAllowRulesGrouped(db),
		listAgentsWithStatus(db, ctx.now),
		listCategoriesWithUsage(db),
		queryChangeLog(db),
	]);

	return adminPageResponse(
		{
			title: RULES_TITLE,
			currentPath: RULES_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: options.flash,
			body: renderRulesPage({
				csrfToken: ctx.csrfToken,
				ruleGroups,
				agents,
				categories,
				changeLog,
				formValues: options.formValues,
			}),
		},
		options.status ?? 200,
	);
}

async function handleGetRules(ctx: AdminGetContext): Promise<Response> {
	return renderRulesScreen(ctx);
}

async function handleGrantRule(ctx: AdminPostContext): Promise<Response> {
	const fromAgentId = (ctx.form.get("from_agent_id") ?? "").trim();
	const toAgentId = (ctx.form.get("to_agent_id") ?? "").trim();
	const categoryId = (ctx.form.get("category_id") ?? "").trim();

	const result = await grantAllowRule(ctx.env.DB, {
		fromAgentId,
		toAgentId,
		categoryId,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderRulesScreen(ctx, {
			status: statusForAdminError(result.code),
			flash: { kind: "error", message: result.message },
			formValues: { fromAgentId, toAgentId, categoryId },
		});
	}

	return renderRulesScreen(ctx, {
		flash: { kind: "success", message: "許可ルールを追加しました。" },
	});
}

async function handleRevokeRule(ctx: AdminPostContext): Promise<Response> {
	const fromAgentId = (ctx.form.get("from_agent_id") ?? "").trim();
	const toAgentId = (ctx.form.get("to_agent_id") ?? "").trim();
	const categoryId = (ctx.form.get("category_id") ?? "").trim();

	const result = await revokeAllowRule(ctx.env.DB, {
		fromAgentId,
		toAgentId,
		categoryId,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderRulesScreen(ctx, {
			status: statusForAdminError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderRulesScreen(ctx, {
		flash: { kind: "success", message: "許可ルールを取り消しました。" },
	});
}

async function handleCreateCategory(ctx: AdminPostContext): Promise<Response> {
	const rawName = ctx.form.get("name") ?? "";
	const result = await createCategory(ctx.env.DB, {
		name: rawName,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderRulesScreen(ctx, {
			status: statusForAdminError(result.code),
			flash: { kind: "error", message: result.message },
			formValues: { categoryName: rawName },
		});
	}

	return renderRulesScreen(ctx, {
		flash: {
			kind: "success",
			message: `カテゴリ「${result.data.category.name}」を追加しました。`,
		},
	});
}

async function handleGetDeleteCategory(
	ctx: AdminGetContext,
): Promise<Response> {
	const categoryId = ctx.params.id ?? "";
	const categories = await listCategoriesWithUsage(ctx.env.DB);
	const target = categories.find((item) => item.category.id === categoryId);

	if (target === undefined) {
		return adminPageResponse(
			{
				title: "カテゴリが見つかりません",
				currentPath: RULES_PATH,
				user: ctx.user,
				devMode: ctx.devMode,
				body: renderCategoryNotFoundPage(),
			},
			404,
		);
	}

	return adminPageResponse({
		title: "カテゴリ削除の確認",
		currentPath: RULES_PATH,
		user: ctx.user,
		devMode: ctx.devMode,
		body: renderDeleteCategoryPage({
			csrfToken: ctx.csrfToken,
			category: target.category,
			allowRuleCount: target.allowRuleCount,
		}),
	});
}

async function handlePostDeleteCategory(
	ctx: AdminPostContext,
): Promise<Response> {
	const categoryId = ctx.params.id ?? "";
	const result = await deleteCategory(ctx.env.DB, {
		categoryId,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderRulesScreen(ctx, {
			status: statusForAdminError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderRulesScreen(ctx, {
		flash: {
			kind: "success",
			message: `カテゴリ「${result.data.category.name}」を削除しました（許可ルール ${result.data.deletedAllowRuleCount} 件も削除）。`,
		},
	});
}

/** Routes for editing directional allow rules and question categories under `/admin`. */
export function ruleRoutes(): AdminRoute[] {
	return [
		{ pattern: RULES_PATH, get: handleGetRules },
		{ pattern: "/admin/rules/grant", post: handleGrantRule },
		{ pattern: "/admin/rules/revoke", post: handleRevokeRule },
		{ pattern: "/admin/categories", post: handleCreateCategory },
		{
			pattern: "/admin/categories/:id/delete",
			get: handleGetDeleteCategory,
			post: handlePostDeleteCategory,
		},
	];
}
