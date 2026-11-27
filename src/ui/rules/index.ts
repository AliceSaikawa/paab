import {
	createCategory,
	deleteCategory,
	grantAllowRule,
	listAgentsWithStatus,
	listAllowRulesGrouped,
	listCategoriesWithUsage,
	queryChangeLog,
	revokeAllowRule,
} from "../../admin";
import { adminRedirectResponse, type FlashKind } from "../flash";
import { adminPageResponse } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import {
	renderCategoryNotFoundPage,
	renderDeleteCategoryPage,
	renderRulesPage,
} from "./render";

const RULES_PATH = "/admin/rules";
const RULES_TITLE = "ルール・カテゴリ";

function ownerActor(ctx: AdminGetContext) {
	return { actorType: "owner" as const, actorId: ctx.user.email };
}

function redirectRules(
	ctx: AdminPostContext,
	kind: FlashKind,
	message: string,
): Response {
	return adminRedirectResponse(RULES_PATH, ctx.url, { kind, message });
}

async function handleGetRules(ctx: AdminGetContext): Promise<Response> {
	const db = ctx.env.DB;
	const [ruleGroups, agents, categories, changeLog] = await Promise.all([
		listAllowRulesGrouped(db),
		listAgentsWithStatus(db, ctx.now),
		listCategoriesWithUsage(db),
		queryChangeLog(db),
	]);

	return adminPageResponse({
		title: RULES_TITLE,
		currentPath: RULES_PATH,
		user: ctx.user,
		devMode: ctx.devMode,
		flash: ctx.flash,
		body: renderRulesPage({
			csrfToken: ctx.csrfToken,
			ruleGroups,
			agents,
			categories,
			changeLog,
		}),
	});
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
		return redirectRules(ctx, "error", result.message);
	}

	return redirectRules(ctx, "success", "許可ルールを追加しました。");
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
		return redirectRules(ctx, "error", result.message);
	}

	return redirectRules(ctx, "success", "許可ルールを取り消しました。");
}

async function handleCreateCategory(ctx: AdminPostContext): Promise<Response> {
	const rawName = ctx.form.get("name") ?? "";
	const result = await createCategory(ctx.env.DB, {
		name: rawName,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectRules(ctx, "error", result.message);
	}

	return redirectRules(
		ctx,
		"success",
		`カテゴリ「${result.data.category.name}」を追加しました。`,
	);
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
				flash: ctx.flash,
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
		flash: ctx.flash,
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
		return redirectRules(ctx, "error", result.message);
	}

	return redirectRules(
		ctx,
		"success",
		`カテゴリ「${result.data.category.name}」を削除しました（許可ルール ${result.data.deletedAllowRuleCount} 件も削除）。`,
	);
}

/** Routes for editing directional allow rules and question categories under `/admin`. */
export function ruleRoutes(): AdminRoute[] {
	return [
		{ pattern: RULES_PATH, get: handleGetRules },
		{
			pattern: "/admin/rules/grant",
			post: handleGrantRule,
			fallbackPath: RULES_PATH,
		},
		{
			pattern: "/admin/rules/revoke",
			post: handleRevokeRule,
			fallbackPath: RULES_PATH,
		},
		{
			pattern: "/admin/categories",
			post: handleCreateCategory,
			fallbackPath: RULES_PATH,
		},
		{
			pattern: "/admin/categories/:id/delete",
			get: handleGetDeleteCategory,
			post: handlePostDeleteCategory,
			fallbackPath: RULES_PATH,
		},
	];
}
