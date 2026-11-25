import {
	type ChangeActor,
	listAdminBotChanges,
	listAgentsWithStatus,
	listCategoriesWithUsage,
	revertAdminBotChange,
	type UndoErrorCode,
} from "../../admin";
import {
	type AdminBotErrorCode,
	clearAdminBot,
	designateAdminBot,
	getAdminBotConfig,
	issueAdminBotToken,
	revokeAdminBotToken,
} from "../../adminbot";
import { adminPageResponse, type FlashMessage } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import { CHANGE_ACTION_LABELS } from "../rules/render";
import { renderAdminBotPageBody, renderIssuedAdminTokenBody } from "./render";

const ADMIN_BOT_PATH = "/admin/adminbot";
const ADMIN_BOT_TITLE = "管理者ボット";

function ownerActor(ctx: AdminPostContext): ChangeActor {
	return { actorType: "owner", actorId: ctx.user.email };
}

function statusForError(code: AdminBotErrorCode): 400 | 404 | 409 {
	switch (code) {
		case "not_found":
			return 404;
		case "not_admin_bot":
			return 409;
		case "invalid_name":
		case "invalid_description":
		case "invalid_limit":
		case "invalid_input":
		case "duplicate_name":
		case "already_suspended":
		case "already_active":
		case "self_addressed":
		case "duplicate_rule":
			return 400;
	}
}

function statusForUndoError(code: UndoErrorCode): 400 | 404 | 409 {
	switch (code) {
		case "not_found":
			return 404;
		case "already_reverted":
		case "conflict_newer_change":
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
		case "not_undoable":
			return 400;
	}
}

async function renderAdminBotScreen(
	ctx: AdminGetContext,
	options: { status?: number; flash?: FlashMessage } = {},
): Promise<Response> {
	const [config, agents, categories, changes] = await Promise.all([
		getAdminBotConfig(ctx.env.DB),
		listAgentsWithStatus(ctx.env.DB, ctx.now),
		listCategoriesWithUsage(ctx.env.DB),
		listAdminBotChanges(ctx.env.DB),
	]);
	const designated =
		config.agentId !== null
			? (agents.find((item) => item.agent.id === config.agentId) ?? null)
			: null;

	return adminPageResponse(
		{
			title: ADMIN_BOT_TITLE,
			currentPath: ADMIN_BOT_PATH,
			user: ctx.user,
			devMode: ctx.devMode,
			flash: options.flash,
			body: renderAdminBotPageBody({
				config,
				designated,
				agents,
				categories,
				changes,
				csrfToken: ctx.csrfToken,
				adminMcpUrl: `${ctx.url.origin}/mcp/admin`,
			}),
		},
		options.status ?? 200,
	);
}

async function handleGetAdminBot(ctx: AdminGetContext): Promise<Response> {
	return renderAdminBotScreen(ctx);
}

async function handleDesignateAdminBot(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = (ctx.form.get("agent_id") ?? "").trim();
	if (agentId.length === 0) {
		return renderAdminBotScreen(ctx, {
			status: 400,
			flash: {
				kind: "error",
				message: "指名するエージェントを選択してください",
			},
		});
	}

	const result = await designateAdminBot(ctx.env.DB, {
		agentId,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderAdminBotScreen(ctx, {
			status: statusForError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	if (!result.data.changed) {
		return renderAdminBotScreen(ctx, {
			flash: {
				kind: "info",
				message: `「${result.data.agent.name}」はすでに管理者ボットに指名されています`,
			},
		});
	}

	const note =
		result.data.previousAgentId !== null
			? "（前の管理者ボットの管理者トークンを失効させ、権限スイッチをリセットしました）"
			: "";
	return renderAdminBotScreen(ctx, {
		flash: {
			kind: "success",
			message: `「${result.data.agent.name}」を管理者ボットに指名しました${note}`,
		},
	});
}

async function handleClearAdminBot(ctx: AdminPostContext): Promise<Response> {
	const result = await clearAdminBot(ctx.env.DB, {
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderAdminBotScreen(ctx, {
			status: statusForError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	if (!result.data.changed) {
		return renderAdminBotScreen(ctx, {
			flash: {
				kind: "info",
				message: "管理者ボットはすでに未指名です",
			},
		});
	}

	return renderAdminBotScreen(ctx, {
		flash: {
			kind: "success",
			message:
				"管理者ボットの指名を解除しました（管理者トークンを失効させ、権限スイッチをリセットしました）",
		},
	});
}

async function resolveTargetAdminAgentId(
	ctx: AdminPostContext,
): Promise<{ ok: true; agentId: string } | { ok: false; response: Response }> {
	const rawAgentId = ctx.form.get("agent_id");
	if (rawAgentId !== null) {
		const trimmed = rawAgentId.trim();
		if (trimmed.length === 0) {
			return {
				ok: false,
				response: await renderAdminBotScreen(ctx, {
					status: 400,
					flash: { kind: "error", message: "エージェントIDを指定してください" },
				}),
			};
		}
		return { ok: true, agentId: trimmed };
	}

	const config = await getAdminBotConfig(ctx.env.DB);
	if (config.agentId === null) {
		return {
			ok: false,
			response: await renderAdminBotScreen(ctx, {
				status: 400,
				flash: {
					kind: "error",
					message: "管理者ボットが指名されていません",
				},
			}),
		};
	}
	return { ok: true, agentId: config.agentId };
}

async function handleIssueAdminBotToken(
	ctx: AdminPostContext,
): Promise<Response> {
	const target = await resolveTargetAdminAgentId(ctx);
	if (!target.ok) return target.response;

	const result = await issueAdminBotToken(ctx.env.DB, {
		agentId: target.agentId,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderAdminBotScreen(ctx, {
			status: statusForError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	const row = await ctx.env.DB.prepare("SELECT name FROM agents WHERE id = ?")
		.bind(target.agentId)
		.first<{ name: string }>();
	const agentName = row?.name ?? target.agentId;

	return adminPageResponse({
		title: "管理者トークン発行",
		currentPath: ADMIN_BOT_PATH,
		user: ctx.user,
		devMode: ctx.devMode,
		flash: {
			kind: "success",
			message: `「${agentName}」の管理者トークンを発行しました`,
		},
		body: renderIssuedAdminTokenBody({
			agentName,
			token: result.data.token,
			revokedPrevious: result.data.revokedPrevious,
			adminMcpUrl: `${ctx.url.origin}/mcp/admin`,
		}),
	});
}

async function handleRevokeAdminBotToken(
	ctx: AdminPostContext,
): Promise<Response> {
	const target = await resolveTargetAdminAgentId(ctx);
	if (!target.ok) return target.response;

	const result = await revokeAdminBotToken(ctx.env.DB, {
		agentId: target.agentId,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderAdminBotScreen(ctx, {
			status: statusForError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderAdminBotScreen(ctx, {
		flash:
			result.data.revokedCount > 0
				? {
						kind: "success",
						message: "管理者トークンを失効させました",
					}
				: {
						kind: "info",
						message: "有効な管理者トークンはありませんでした",
					},
	});
}

async function handleRevertAdminBotChange(
	ctx: AdminPostContext,
): Promise<Response> {
	const rawId = ctx.params.id ?? "";
	if (!/^\d+$/.test(rawId)) {
		return renderAdminBotScreen(ctx, {
			status: 400,
			flash: { kind: "error", message: "変更IDが不正です" },
		});
	}
	const changeId = Number(rawId);
	if (!Number.isSafeInteger(changeId) || changeId <= 0) {
		return renderAdminBotScreen(ctx, {
			status: 400,
			flash: { kind: "error", message: "変更IDが不正です" },
		});
	}

	const result = await revertAdminBotChange(ctx.env.DB, {
		changeId,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return renderAdminBotScreen(ctx, {
			status: statusForUndoError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	return renderAdminBotScreen(ctx, {
		flash: {
			kind: "success",
			message: `変更 #${result.data.revertedChangeId}（${CHANGE_ACTION_LABELS[result.data.action]}）を元に戻しました`,
		},
	});
}

/** Admin UI routes for designating the admin bot and managing its `/mcp/admin` token. */
export function adminBotRoutes(): AdminRoute[] {
	return [
		{ pattern: ADMIN_BOT_PATH, get: handleGetAdminBot },
		{ pattern: "/admin/adminbot/designate", post: handleDesignateAdminBot },
		{ pattern: "/admin/adminbot/clear", post: handleClearAdminBot },
		{ pattern: "/admin/adminbot/token", post: handleIssueAdminBotToken },
		{
			pattern: "/admin/adminbot/token/revoke",
			post: handleRevokeAdminBotToken,
		},
		{
			pattern: "/admin/adminbot/changes/:id/revert",
			post: handleRevertAdminBotChange,
		},
	];
}
