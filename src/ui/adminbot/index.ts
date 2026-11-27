import {
	type ChangeActor,
	listAdminBotChanges,
	listAgentsWithStatus,
	listCategoriesWithUsage,
	revertAdminBotChange,
} from "../../admin";
import {
	clearAdminBot,
	designateAdminBot,
	getAdminBotConfig,
	getSuperadminState,
	issueAdminBotToken,
	MAX_SUPERADMIN_DAYS,
	revokeAdminBotToken,
	setAdminBotReadBodies,
	setAdminBotSuperadmin,
	wouldEnableBothOptionalPermissions,
} from "../../adminbot";
import { isBodyRecordingEnabled } from "../../audit";
import { auditBodyConfig } from "../../mcp/config";
import { rotateCsrfCookie } from "../csrf";
import { adminRedirectResponse, type FlashKind } from "../flash";
import { adminPageResponse } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import { CHANGE_ACTION_LABELS } from "../rules/render";
import {
	renderAdminBotPageBody,
	renderBothPermissionsConfirmBody,
	renderIssuedAdminTokenBody,
} from "./render";

const ADMIN_BOT_PATH = "/admin/adminbot";
const ADMIN_BOT_TITLE = "管理者ボット";

function ownerActor(ctx: AdminPostContext): ChangeActor {
	return { actorType: "owner", actorId: ctx.user.email };
}

function redirectAdminBot(
	ctx: AdminPostContext,
	kind: FlashKind,
	message: string,
): Response {
	return adminRedirectResponse(ADMIN_BOT_PATH, ctx.url, { kind, message });
}

async function handleGetAdminBot(ctx: AdminGetContext): Promise<Response> {
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
	const bodyRecordingEnabled = isBodyRecordingEnabled(auditBodyConfig(ctx.env));

	return adminPageResponse({
		title: ADMIN_BOT_TITLE,
		currentPath: ADMIN_BOT_PATH,
		user: ctx.user,
		devMode: ctx.devMode,
		flash: ctx.flash,
		body: renderAdminBotPageBody({
			config,
			designated,
			agents,
			categories,
			changes,
			bodyRecordingEnabled,
			now: ctx.now,
			csrfToken: ctx.csrfToken,
			adminMcpUrl: `${ctx.url.origin}/mcp/admin`,
		}),
	});
}

async function handleDesignateAdminBot(
	ctx: AdminPostContext,
): Promise<Response> {
	const agentId = (ctx.form.get("agent_id") ?? "").trim();
	if (agentId.length === 0) {
		return redirectAdminBot(
			ctx,
			"error",
			"指名するエージェントを選択してください",
		);
	}

	const result = await designateAdminBot(ctx.env.DB, {
		agentId,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAdminBot(ctx, "error", result.message);
	}

	if (!result.data.changed) {
		return redirectAdminBot(
			ctx,
			"info",
			`「${result.data.agent.name}」はすでに管理者ボットに指名されています`,
		);
	}

	const note =
		result.data.previousAgentId !== null
			? "（前の管理者ボットの管理者トークンを失効させ、権限スイッチをリセットしました）"
			: "";
	return redirectAdminBot(
		ctx,
		"success",
		`「${result.data.agent.name}」を管理者ボットに指名しました${note}`,
	);
}

async function handleClearAdminBot(ctx: AdminPostContext): Promise<Response> {
	const result = await clearAdminBot(ctx.env.DB, {
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAdminBot(ctx, "error", result.message);
	}

	if (!result.data.changed) {
		return redirectAdminBot(ctx, "info", "管理者ボットはすでに未指名です");
	}

	return redirectAdminBot(
		ctx,
		"success",
		"管理者ボットの指名を解除しました（管理者トークンを失効させ、権限スイッチをリセットしました）",
	);
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
				response: redirectAdminBot(
					ctx,
					"error",
					"エージェントIDを指定してください",
				),
			};
		}
		return { ok: true, agentId: trimmed };
	}

	const config = await getAdminBotConfig(ctx.env.DB);
	if (config.agentId === null) {
		return {
			ok: false,
			response: redirectAdminBot(
				ctx,
				"error",
				"管理者ボットが指名されていません",
			),
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
		return redirectAdminBot(ctx, "error", result.message);
	}

	const row = await ctx.env.DB.prepare("SELECT name FROM agents WHERE id = ?")
		.bind(target.agentId)
		.first<{ name: string }>();
	const agentName = row?.name ?? target.agentId;

	return rotateCsrfCookie(
		adminPageResponse({
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
		}),
		ctx.url,
	);
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
		return redirectAdminBot(ctx, "error", result.message);
	}

	return result.data.revokedCount > 0
		? redirectAdminBot(ctx, "success", "管理者トークンを失効させました")
		: redirectAdminBot(ctx, "info", "有効な管理者トークンはありませんでした");
}

async function resolveAgentDisplayName(
	db: D1Database,
	agentId: string,
): Promise<string> {
	const row = await db
		.prepare("SELECT name FROM agents WHERE id = ?")
		.bind(agentId)
		.first<{ name: string }>();
	return row?.name ?? agentId;
}

function parseEnabledField(raw: string | null): boolean | null {
	if (raw === null) return null;
	const value = raw.trim();
	if (value === "1") return true;
	if (value === "0") return false;
	return null;
}

type ParsedSuperadminDuration =
	| { mode: "off" }
	| { mode: "permanent"; formValue: "permanent" }
	| { mode: "days"; days: number; formValue: string };

function parseSuperadminDuration(
	raw: string | null,
): ParsedSuperadminDuration | null {
	if (raw === null) return null;
	const value = raw.trim();
	if (value === "off") return { mode: "off" };
	if (value === "permanent") {
		return { mode: "permanent", formValue: "permanent" };
	}
	if (!/^[1-9]\d*$/.test(value)) return null;
	const days = Number(value);
	if (!Number.isSafeInteger(days) || days < 1 || days > MAX_SUPERADMIN_DAYS) {
		return null;
	}
	return { mode: "days", days, formValue: String(days) };
}

async function handleToggleReadBodies(
	ctx: AdminPostContext,
): Promise<Response> {
	const enabled = parseEnabledField(ctx.form.get("enabled"));
	if (enabled === null) {
		return redirectAdminBot(ctx, "error", "本文閲覧スイッチの指定が不正です");
	}

	if (enabled) {
		const current = await getAdminBotConfig(ctx.env.DB);
		if (
			current.agentId !== null &&
			wouldEnableBothOptionalPermissions(current, ctx.now, {
				readBodies: true,
			}) &&
			ctx.form.get("confirm_both") !== "1"
		) {
			const agentName = await resolveAgentDisplayName(
				ctx.env.DB,
				current.agentId,
			);
			const superadminState = getSuperadminState(current, ctx.now);
			return adminPageResponse({
				title: "本文閲覧と最高管理者権限の同時有効化の確認",
				currentPath: ADMIN_BOT_PATH,
				user: ctx.user,
				devMode: ctx.devMode,
				body: renderBothPermissionsConfirmBody({
					agentName,
					action: "/admin/adminbot/permissions/read-bodies",
					hiddenFields: [
						{ name: "enabled", value: "1" },
						{ name: "confirm_both", value: "1" },
					],
					enablingLabel: "本文閲覧",
					alreadyEnabledLabel:
						superadminState.kind === "permanent"
							? "最高管理者権限（無期限）"
							: "最高管理者権限",
					csrfToken: ctx.csrfToken,
				}),
			});
		}
	}

	const result = await setAdminBotReadBodies(ctx.env.DB, {
		enabled,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAdminBot(ctx, "error", result.message);
	}

	if (!result.data.changed) {
		return redirectAdminBot(
			ctx,
			"info",
			enabled ? "本文閲覧はすでにオンです" : "本文閲覧はすでにオフです",
		);
	}

	const bodyRecordingEnabled = isBodyRecordingEnabled(auditBodyConfig(ctx.env));
	const message = enabled
		? bodyRecordingEnabled
			? "本文閲覧をオンにしました"
			: "本文閲覧をオンにしました（監査ログへの本文記録が無効のため、現在読める本文はありません）"
		: "本文閲覧をオフにしました";

	return redirectAdminBot(ctx, "success", message);
}

async function handleSetSuperadmin(ctx: AdminPostContext): Promise<Response> {
	const parsed = parseSuperadminDuration(ctx.form.get("duration"));
	if (parsed === null) {
		return redirectAdminBot(
			ctx,
			"error",
			"最高管理者権限の有効期間の指定が不正です",
		);
	}

	if (parsed.mode !== "off") {
		const current = await getAdminBotConfig(ctx.env.DB);
		if (
			current.agentId !== null &&
			wouldEnableBothOptionalPermissions(current, ctx.now, {
				superadminActive: true,
			}) &&
			ctx.form.get("confirm_both") !== "1"
		) {
			const agentName = await resolveAgentDisplayName(
				ctx.env.DB,
				current.agentId,
			);
			return adminPageResponse({
				title: "本文閲覧と最高管理者権限の同時有効化の確認",
				currentPath: ADMIN_BOT_PATH,
				user: ctx.user,
				devMode: ctx.devMode,
				body: renderBothPermissionsConfirmBody({
					agentName,
					action: "/admin/adminbot/permissions/superadmin",
					hiddenFields: [
						{ name: "duration", value: parsed.formValue },
						{ name: "confirm_both", value: "1" },
					],
					enablingLabel:
						parsed.mode === "permanent"
							? "最高管理者権限（無期限）"
							: `最高管理者権限（${parsed.days}日間）`,
					alreadyEnabledLabel: "本文閲覧",
					csrfToken: ctx.csrfToken,
				}),
			});
		}
	}

	const result = await setAdminBotSuperadmin(
		ctx.env.DB,
		parsed.mode === "off"
			? { mode: "off", actor: ownerActor(ctx), now: ctx.now }
			: parsed.mode === "permanent"
				? { mode: "permanent", actor: ownerActor(ctx), now: ctx.now }
				: {
						mode: "days",
						days: parsed.days,
						actor: ownerActor(ctx),
						now: ctx.now,
					},
	);
	if (!result.ok) {
		return redirectAdminBot(ctx, "error", result.message);
	}

	if (!result.data.changed) {
		const infoMessage =
			parsed.mode === "off"
				? "最高管理者権限はすでにオフです"
				: parsed.mode === "permanent"
					? "最高管理者権限はすでに無期限で有効です"
					: "最高管理者権限の有効期限は変更されませんでした";
		return redirectAdminBot(ctx, "info", infoMessage);
	}

	const successMessage =
		parsed.mode === "off"
			? "最高管理者権限をオフにしました"
			: parsed.mode === "permanent"
				? "最高管理者権限を無期限でオンにしました"
				: `最高管理者権限を ${parsed.days} 日間オンにしました`;

	return redirectAdminBot(ctx, "success", successMessage);
}

async function handleRevertAdminBotChange(
	ctx: AdminPostContext,
): Promise<Response> {
	const rawId = ctx.params.id ?? "";
	if (!/^\d+$/.test(rawId)) {
		return redirectAdminBot(ctx, "error", "変更IDが不正です");
	}
	const changeId = Number(rawId);
	if (!Number.isSafeInteger(changeId) || changeId <= 0) {
		return redirectAdminBot(ctx, "error", "変更IDが不正です");
	}

	const result = await revertAdminBotChange(ctx.env.DB, {
		changeId,
		actor: ownerActor(ctx),
		now: ctx.now,
	});
	if (!result.ok) {
		return redirectAdminBot(ctx, "error", result.message);
	}

	return redirectAdminBot(
		ctx,
		"success",
		`変更 #${result.data.revertedChangeId}（${CHANGE_ACTION_LABELS[result.data.action]}）を元に戻しました`,
	);
}

/** Admin UI routes for designating the admin bot and managing its `/mcp/admin` token. */
export function adminBotRoutes(): AdminRoute[] {
	return [
		{ pattern: ADMIN_BOT_PATH, get: handleGetAdminBot },
		{
			pattern: "/admin/adminbot/designate",
			post: handleDesignateAdminBot,
			fallbackPath: ADMIN_BOT_PATH,
		},
		{
			pattern: "/admin/adminbot/clear",
			post: handleClearAdminBot,
			fallbackPath: ADMIN_BOT_PATH,
		},
		{
			pattern: "/admin/adminbot/token",
			post: handleIssueAdminBotToken,
			fallbackPath: ADMIN_BOT_PATH,
		},
		{
			pattern: "/admin/adminbot/token/revoke",
			post: handleRevokeAdminBotToken,
			fallbackPath: ADMIN_BOT_PATH,
		},
		{
			pattern: "/admin/adminbot/permissions/read-bodies",
			post: handleToggleReadBodies,
			fallbackPath: ADMIN_BOT_PATH,
		},
		{
			pattern: "/admin/adminbot/permissions/superadmin",
			post: handleSetSuperadmin,
			fallbackPath: ADMIN_BOT_PATH,
		},
		{
			pattern: "/admin/adminbot/changes/:id/revert",
			post: handleRevertAdminBotChange,
			fallbackPath: ADMIN_BOT_PATH,
		},
	];
}
