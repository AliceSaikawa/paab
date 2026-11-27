import {
	type ChangeActor,
	configureAgentWebhook,
	deleteAgent,
	deleteAgentWebhook,
	issueAgentToken,
	listAgentsWithStatus,
	listAgentWebhooks,
	registerAgent,
	resolveDefaultOwnerId,
	resumeAgent,
	revokeAgentTokens,
	rotateAgentWebhookSecret,
	suspendAgent,
	updateAgent,
} from "../../admin";
import { allowInsecureLocalhostWebhook } from "../../mcp/config";
import { WEBHOOK_AUTH_MODES, type WebhookAuthMode } from "../../types";
import { rotateCsrfCookie } from "../csrf";
import { adminRedirectResponse, type FlashKind } from "../flash";
import { adminPageResponse, type FlashMessage } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import {
	renderAgentsPageBody,
	renderDeleteConfirmBody,
	renderIssuedTokenBody,
	renderIssuedUnreadTokenBody,
	renderRevealedWebhookSecretBody,
} from "./render";

const AGENTS_PATH = "/admin/agents";
const NON_NEGATIVE_INT_PATTERN = /^\d+$/;

function actorFrom(ctx: AdminPostContext): ChangeActor {
	return { actorType: "owner", actorId: ctx.user.email };
}

function redirectAgents(
	ctx: AdminPostContext,
	kind: FlashKind,
	message: string,
): Response {
	return adminRedirectResponse(AGENTS_PATH, ctx.url, { kind, message });
}

function normalizeTextareaLineBreaks(raw: string): string {
	return raw.replaceAll("\r\n", "\n");
}

function parseDailyQuestionLimit(
	raw: string | null,
): { ok: true; value: number } | { ok: false; message: string } {
	if (raw === null) {
		return {
			ok: false,
			message: "1日あたりの質問数上限を入力してください",
		};
	}
	const trimmed = raw.trim();
	if (!NON_NEGATIVE_INT_PATTERN.test(trimmed)) {
		return {
			ok: false,
			message: "1日あたりの質問数上限は0以上の整数で入力してください",
		};
	}
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value)) {
		return {
			ok: false,
			message: "1日あたりの質問数上限は安全な整数範囲で入力してください",
		};
	}
	return { ok: true, value };
}

async function renderAgentsList(
	ctx: AdminGetContext,
	options: {
		status?: number;
		flash?: FlashMessage;
	} = {},
): Promise<Response> {
	const [agents, defaultOwnerId, webhooks] = await Promise.all([
		listAgentsWithStatus(ctx.env.DB, ctx.now),
		resolveDefaultOwnerId(ctx.env.DB),
		listAgentWebhooks(ctx.env.DB),
	]);
	const webhooksByAgentId = new Map(
		webhooks.map((webhook) => [webhook.agentId, webhook]),
	);
	return adminPageResponse(
		{
			title: "エージェント",
			currentPath: AGENTS_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: options.flash ?? ctx.flash,
			body: renderAgentsPageBody({
				agents,
				webhooksByAgentId,
				defaultOwnerId,
				csrfToken: ctx.csrfToken,
			}),
		},
		options.status ?? 200,
	);
}

async function handleGetAgents(ctx: AdminGetContext): Promise<Response> {
	return renderAgentsList(ctx);
}

async function handleRegisterAgent(ctx: AdminPostContext): Promise<Response> {
	const name = ctx.form.get("name");
	const description = normalizeTextareaLineBreaks(
		ctx.form.get("description") ?? "",
	);
	const rawLimit = ctx.form.get("daily_question_limit");
	const rawOwnerId = ctx.form.get("owner_id");

	if (name === null) {
		return redirectAgents(ctx, "error", "エージェント名を入力してください");
	}

	const limit = parseDailyQuestionLimit(rawLimit);
	if (!limit.ok) {
		return redirectAgents(ctx, "error", limit.message);
	}

	const ownerId =
		rawOwnerId !== null && rawOwnerId.trim().length > 0
			? rawOwnerId
			: undefined;

	const result = await registerAgent(ctx.env.DB, {
		name,
		description,
		dailyQuestionLimit: limit.value,
		ownerId,
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	return redirectAgents(
		ctx,
		"success",
		`エージェント「${result.data.agent.name}」を登録しました`,
	);
}

async function handleUpdateAgent(ctx: AdminPostContext): Promise<Response> {
	const agentId = ctx.params.id ?? "";
	const limit = parseDailyQuestionLimit(ctx.form.get("daily_question_limit"));
	if (!limit.ok) {
		return redirectAgents(ctx, "error", limit.message);
	}

	const rawDescription = ctx.form.get("description");
	const description =
		rawDescription !== null
			? normalizeTextareaLineBreaks(rawDescription)
			: undefined;

	const result = await updateAgent(ctx.env.DB, {
		agentId,
		description,
		dailyQuestionLimit: limit.value,
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	return result.data.changed
		? redirectAgents(
				ctx,
				"success",
				`エージェント「${result.data.agent.name}」を更新しました`,
			)
		: redirectAgents(
				ctx,
				"info",
				`エージェント「${result.data.agent.name}」に変更はありませんでした`,
			);
}

async function handleStatusChange(
	ctx: AdminPostContext,
	nextStatus: "suspended" | "active",
): Promise<Response> {
	const op = nextStatus === "suspended" ? suspendAgent : resumeAgent;
	const result = await op(ctx.env.DB, {
		agentId: ctx.params.id ?? "",
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}
	const verb = nextStatus === "suspended" ? "停止" : "再開";
	return redirectAgents(
		ctx,
		"success",
		`エージェント「${result.data.agent.name}」を${verb}しました`,
	);
}

async function handleGetDeleteConfirm(ctx: AdminGetContext): Promise<Response> {
	const agentId = ctx.params.id ?? "";
	const agents = await listAgentsWithStatus(ctx.env.DB, ctx.now);
	const entry = agents.find((item) => item.agent.id === agentId);
	if (entry === undefined) {
		return renderAgentsList(ctx, {
			status: 404,
			flash: {
				kind: "error",
				message: "指定されたエージェントが見つかりません",
			},
		});
	}

	return adminPageResponse({
		title: "エージェント削除確認",
		currentPath: AGENTS_PATH,
		user: ctx.user,
		devMode: ctx.devMode,
		flash: ctx.flash,
		body: renderDeleteConfirmBody({
			entry,
			csrfToken: ctx.csrfToken,
		}),
	});
}

async function handleDeleteAgent(ctx: AdminPostContext): Promise<Response> {
	const result = await deleteAgent(ctx.env.DB, {
		agentId: ctx.params.id ?? "",
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	const ruleNote =
		result.data.deletedAllowRuleCount > 0
			? `（許可ルール ${result.data.deletedAllowRuleCount}件も削除しました）`
			: "";
	return redirectAgents(
		ctx,
		"success",
		`エージェント「${result.data.agent.name}」を削除しました${ruleNote}`,
	);
}

async function handleIssueParticipantToken(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = ctx.params.id ?? "";
	const result = await issueAgentToken(ctx.env.DB, {
		agentId,
		purpose: "participant",
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	const agents = await listAgentsWithStatus(ctx.env.DB, ctx.now);
	const agentName =
		agents.find((item) => item.agent.id === agentId)?.agent.name ?? agentId;

	return rotateCsrfCookie(
		adminPageResponse({
			title: "参加者トークン発行",
			currentPath: AGENTS_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: {
				kind: "success",
				message: `「${agentName}」の参加者トークンを発行しました`,
			},
			body: renderIssuedTokenBody({
				agentName,
				token: result.data.token,
				revokedPrevious: result.data.revokedPrevious,
				mcpUrl: `${ctx.url.origin}/mcp`,
			}),
		}),
		ctx.url,
	);
}

async function handleRevokeParticipantToken(
	ctx: AdminPostContext,
): Promise<Response> {
	const result = await revokeAgentTokens(ctx.env.DB, {
		agentId: ctx.params.id ?? "",
		purpose: "participant",
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	return result.data.revokedCount > 0
		? redirectAgents(ctx, "success", "参加者トークンを失効させました")
		: redirectAgents(ctx, "info", "有効な参加者トークンはありませんでした");
}

async function handleIssueUnreadToken(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = ctx.params.id ?? "";
	const result = await issueAgentToken(ctx.env.DB, {
		agentId,
		purpose: "unread_count",
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	const agents = await listAgentsWithStatus(ctx.env.DB, ctx.now);
	const agentName =
		agents.find((item) => item.agent.id === agentId)?.agent.name ?? agentId;

	return rotateCsrfCookie(
		adminPageResponse({
			title: "件数確認トークン発行",
			currentPath: AGENTS_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: {
				kind: "success",
				message: `「${agentName}」の件数確認トークンを発行しました`,
			},
			body: renderIssuedUnreadTokenBody({
				agentName,
				token: result.data.token,
				revokedPrevious: result.data.revokedPrevious,
				unreadUrl: `${ctx.url.origin}/unread`,
			}),
		}),
		ctx.url,
	);
}

async function handleRevokeUnreadToken(
	ctx: AdminPostContext,
): Promise<Response> {
	const result = await revokeAgentTokens(ctx.env.DB, {
		agentId: ctx.params.id ?? "",
		purpose: "unread_count",
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	return result.data.revokedCount > 0
		? redirectAgents(ctx, "success", "件数確認トークンを失効させました")
		: redirectAgents(ctx, "info", "有効な件数確認トークンはありませんでした");
}

async function resolveAgentName(
	db: D1Database,
	agentId: string,
): Promise<string> {
	const row = await db
		.prepare("SELECT name FROM agents WHERE id = ?")
		.bind(agentId)
		.first<{ name: string }>();
	return row?.name ?? agentId;
}

function isWebhookAuthMode(value: string): value is WebhookAuthMode {
	return (WEBHOOK_AUTH_MODES as readonly string[]).includes(value);
}

async function handleConfigureWebhook(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = ctx.params.id ?? "";
	const url = ctx.form.get("url") ?? "";
	const rawAuthMode = ctx.form.get("auth_mode") ?? "";
	if (!isWebhookAuthMode(rawAuthMode)) {
		return redirectAgents(ctx, "error", "認証方式が不正です");
	}
	const authMode = rawAuthMode;
	const headerName = ctx.form.get("header_name");
	const secret = ctx.form.get("secret");

	const result = await configureAgentWebhook(ctx.env.DB, {
		agentId,
		url,
		authMode,
		headerName,
		secret,
		actor: actorFrom(ctx),
		now: ctx.now,
		allowInsecureLocalhost: allowInsecureLocalhostWebhook(ctx.env),
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	if (result.data.revealedSecret !== null) {
		const agentName = await resolveAgentName(ctx.env.DB, agentId);
		return rotateCsrfCookie(
			adminPageResponse({
				title: "Webhook 署名鍵発行",
				currentPath: AGENTS_PATH,
				user: ctx.user,
				devMode: ctx.devMode,
				flash: {
					kind: "success",
					message: `「${agentName}」の Webhook を設定しました`,
				},
				body: renderRevealedWebhookSecretBody({
					agentName,
					url: result.data.webhook.url,
					secret: result.data.revealedSecret,
					rotated: false,
				}),
			}),
			ctx.url,
		);
	}

	return redirectAgents(
		ctx,
		"success",
		`Webhook を保存しました（方式: ${result.data.webhook.authMode}）`,
	);
}

async function handleRotateWebhookSecret(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = ctx.params.id ?? "";
	const result = await rotateAgentWebhookSecret(ctx.env.DB, {
		agentId,
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	const agentName = await resolveAgentName(ctx.env.DB, agentId);
	return rotateCsrfCookie(
		adminPageResponse({
			title: "Webhook 署名鍵ローテーション",
			currentPath: AGENTS_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: {
				kind: "success",
				message: `「${agentName}」の Webhook 署名鍵をローテーションしました`,
			},
			body: renderRevealedWebhookSecretBody({
				agentName,
				url: result.data.webhook.url,
				secret: result.data.revealedSecret,
				rotated: true,
			}),
		}),
		ctx.url,
	);
}

async function handleDeleteWebhook(ctx: AdminPostContext): Promise<Response> {
	const result = await deleteAgentWebhook(ctx.env.DB, {
		agentId: ctx.params.id ?? "",
		actor: actorFrom(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAgents(ctx, "error", result.message);
	}

	return redirectAgents(ctx, "success", "Webhook 設定を削除しました");
}

export function agentRoutes(): AdminRoute[] {
	return [
		{
			pattern: "/admin/agents",
			get: handleGetAgents,
			post: handleRegisterAgent,
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/update",
			post: handleUpdateAgent,
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/suspend",
			post: (ctx) => handleStatusChange(ctx, "suspended"),
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/resume",
			post: (ctx) => handleStatusChange(ctx, "active"),
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/delete",
			get: handleGetDeleteConfirm,
			post: handleDeleteAgent,
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/token",
			post: handleIssueParticipantToken,
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/token/revoke",
			post: handleRevokeParticipantToken,
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/unread-token",
			post: handleIssueUnreadToken,
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/unread-token/revoke",
			post: handleRevokeUnreadToken,
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/webhook",
			post: handleConfigureWebhook,
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/webhook/rotate",
			post: handleRotateWebhookSecret,
			fallbackPath: AGENTS_PATH,
		},
		{
			pattern: "/admin/agents/:id/webhook/delete",
			post: handleDeleteWebhook,
			fallbackPath: AGENTS_PATH,
		},
	];
}
