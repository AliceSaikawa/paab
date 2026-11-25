import {
	type AdminErrorCode,
	type ChangeActor,
	deleteAgent,
	issueAgentToken,
	listAgentsWithStatus,
	registerAgent,
	resolveDefaultOwnerId,
	resumeAgent,
	revokeAgentTokens,
	suspendAgent,
	updateAgent,
} from "../../admin";
import { adminPageResponse, type FlashMessage } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import {
	type RegisterFormDraft,
	renderAgentsPageBody,
	renderDeleteConfirmBody,
	renderIssuedTokenBody,
} from "./render";

const AGENTS_PATH = "/admin/agents";
const NON_NEGATIVE_INT_PATTERN = /^\d+$/;

function actorFrom(ctx: AdminPostContext): ChangeActor {
	return { actorType: "owner", actorId: ctx.user.email };
}

function errorStatus(code: AdminErrorCode): 400 | 404 {
	return code === "not_found" ? 404 : 400;
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
		registerDraft?: RegisterFormDraft;
	} = {},
): Promise<Response> {
	const [agents, defaultOwnerId] = await Promise.all([
		listAgentsWithStatus(ctx.env.DB, ctx.now),
		resolveDefaultOwnerId(ctx.env.DB),
	]);
	return adminPageResponse(
		{
			title: "エージェント",
			currentPath: AGENTS_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: options.flash,
			body: renderAgentsPageBody({
				agents,
				defaultOwnerId,
				csrfToken: ctx.csrfToken,
				registerDraft: options.registerDraft,
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
	const registerDraft: RegisterFormDraft = {
		name: name ?? "",
		description,
		dailyQuestionLimit: rawLimit ?? "",
		ownerId: rawOwnerId ?? "",
	};

	if (name === null) {
		return renderAgentsList(ctx, {
			status: 400,
			flash: { kind: "error", message: "エージェント名を入力してください" },
			registerDraft,
		});
	}

	const limit = parseDailyQuestionLimit(rawLimit);
	if (!limit.ok) {
		return renderAgentsList(ctx, {
			status: 400,
			flash: { kind: "error", message: limit.message },
			registerDraft,
		});
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
		return renderAgentsList(ctx, {
			status: errorStatus(result.code),
			flash: { kind: "error", message: result.message },
			registerDraft,
		});
	}

	return renderAgentsList(ctx, {
		flash: {
			kind: "success",
			message: `エージェント「${result.data.agent.name}」を登録しました`,
		},
	});
}

async function handleUpdateAgent(ctx: AdminPostContext): Promise<Response> {
	const agentId = ctx.params.id ?? "";
	const limit = parseDailyQuestionLimit(ctx.form.get("daily_question_limit"));
	if (!limit.ok) {
		return renderAgentsList(ctx, {
			status: 400,
			flash: { kind: "error", message: limit.message },
		});
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
		return renderAgentsList(ctx, {
			status: errorStatus(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderAgentsList(ctx, {
		flash: result.data.changed
			? {
					kind: "success",
					message: `エージェント「${result.data.agent.name}」を更新しました`,
				}
			: {
					kind: "info",
					message: `エージェント「${result.data.agent.name}」に変更はありませんでした`,
				},
	});
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
		return renderAgentsList(ctx, {
			status: errorStatus(result.code),
			flash: { kind: "error", message: result.message },
		});
	}
	const verb = nextStatus === "suspended" ? "停止" : "再開";
	return renderAgentsList(ctx, {
		flash: {
			kind: "success",
			message: `エージェント「${result.data.agent.name}」を${verb}しました`,
		},
	});
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
		return renderAgentsList(ctx, {
			status: errorStatus(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	const ruleNote =
		result.data.deletedAllowRuleCount > 0
			? `（許可ルール ${result.data.deletedAllowRuleCount}件も削除しました）`
			: "";
	return renderAgentsList(ctx, {
		flash: {
			kind: "success",
			message: `エージェント「${result.data.agent.name}」を削除しました${ruleNote}`,
		},
	});
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
		return renderAgentsList(ctx, {
			status: errorStatus(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	const agents = await listAgentsWithStatus(ctx.env.DB, ctx.now);
	const agentName =
		agents.find((item) => item.agent.id === agentId)?.agent.name ?? agentId;

	return adminPageResponse({
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
	});
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
		return renderAgentsList(ctx, {
			status: errorStatus(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderAgentsList(ctx, {
		flash:
			result.data.revokedCount > 0
				? {
						kind: "success",
						message: "参加者トークンを失効させました",
					}
				: {
						kind: "info",
						message: "有効な参加者トークンはありませんでした",
					},
	});
}

export function agentRoutes(): AdminRoute[] {
	return [
		{
			pattern: "/admin/agents",
			get: handleGetAgents,
			post: handleRegisterAgent,
		},
		{
			pattern: "/admin/agents/:id/update",
			post: handleUpdateAgent,
		},
		{
			pattern: "/admin/agents/:id/suspend",
			post: (ctx) => handleStatusChange(ctx, "suspended"),
		},
		{
			pattern: "/admin/agents/:id/resume",
			post: (ctx) => handleStatusChange(ctx, "active"),
		},
		{
			pattern: "/admin/agents/:id/delete",
			get: handleGetDeleteConfirm,
			post: handleDeleteAgent,
		},
		{
			pattern: "/admin/agents/:id/token",
			post: handleIssueParticipantToken,
		},
		{
			pattern: "/admin/agents/:id/token/revoke",
			post: handleRevokeParticipantToken,
		},
	];
}
