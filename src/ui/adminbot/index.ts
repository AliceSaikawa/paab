import {
	type ChangeActor,
	countUnrevertedAdminBotChanges,
	DEFAULT_CHANGE_LOG_LIMIT,
	inspectAdminBotChangesUndoState,
	listAdminBotChanges,
	listAgentsWithStatus,
	listCategoriesWithUsage,
	MAX_CHANGE_LOG_LIMIT,
	revertAdminBotChange,
	type UndoErrorCode,
} from "../../admin";
import {
	type AdminBotErrorCode,
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
import { CHANGE_TARGET_TYPES, type ChangeTargetType } from "../../types";
import { adminPageResponse, type FlashMessage } from "../layout";
import type { AdminGetContext, AdminPostContext, AdminRoute } from "../router";
import { CHANGE_ACTION_LABELS } from "../rules/render";
import {
	type AdminBotChangesQuery,
	renderAdminBotPageBody,
	renderBothPermissionsConfirmBody,
	renderIssuedAdminTokenBody,
} from "./render";

const ADMIN_BOT_PATH = "/admin/adminbot";
const ADMIN_BOT_TITLE = "管理者ボット";
// Reserve 1 row for lookahead pagination so queryChangeLog does not clamp the probe.
const MAX_UI_CHANGE_LIMIT = MAX_CHANGE_LOG_LIMIT - 1;

function defaultChangesQuery(): AdminBotChangesQuery {
	return {
		unrevertedOnly: false,
		limit: DEFAULT_CHANGE_LOG_LIMIT,
	};
}

function parseChangesQuery(
	params: URLSearchParams,
	prefix = "",
):
	| { ok: true; query: AdminBotChangesQuery }
	| { ok: false; error: string; fallback: AdminBotChangesQuery } {
	const unrevertedOnly = params.get(`${prefix}unreverted`) === "1";
	const rawTargetType = (params.get(`${prefix}target_type`) ?? "").trim();
	const rawBeforeId = (params.get(`${prefix}before_id`) ?? "").trim();
	const rawLimit = (params.get(`${prefix}limit`) ?? "").trim();

	const fallback: AdminBotChangesQuery = {
		unrevertedOnly,
		limit: DEFAULT_CHANGE_LOG_LIMIT,
	};

	let targetType: ChangeTargetType | undefined;
	if (rawTargetType.length > 0) {
		if (!(CHANGE_TARGET_TYPES as readonly string[]).includes(rawTargetType)) {
			return {
				ok: false,
				error: `対象の指定が不正です: ${rawTargetType}`,
				fallback,
			};
		}
		targetType = rawTargetType as ChangeTargetType;
		fallback.targetType = targetType;
	}

	let beforeId: number | undefined;
	if (rawBeforeId.length > 0) {
		if (!/^\d+$/.test(rawBeforeId)) {
			return {
				ok: false,
				error: `before_id は 0 以上の整数で指定してください: ${rawBeforeId}`,
				fallback,
			};
		}
		const parsed = Number(rawBeforeId);
		if (!Number.isSafeInteger(parsed)) {
			return {
				ok: false,
				error: `before_id は 0 以上の整数で指定してください: ${rawBeforeId}`,
				fallback,
			};
		}
		beforeId = parsed;
	}

	let limit = DEFAULT_CHANGE_LOG_LIMIT;
	if (rawLimit.length > 0) {
		if (!/^[1-9]\d*$/.test(rawLimit)) {
			return {
				ok: false,
				error: `limit は 1 以上の整数で指定してください: ${rawLimit}`,
				fallback,
			};
		}
		const parsed = Number(rawLimit);
		if (!Number.isSafeInteger(parsed)) {
			return {
				ok: false,
				error: `limit は 1 以上の整数で指定してください: ${rawLimit}`,
				fallback,
			};
		}
		limit = Math.min(parsed, MAX_UI_CHANGE_LIMIT);
	}

	return {
		ok: true,
		query: {
			unrevertedOnly,
			targetType,
			beforeId,
			limit,
		},
	};
}

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
	options: {
		status?: number;
		flash?: FlashMessage;
		changeQuery?: AdminBotChangesQuery;
	} = {},
): Promise<Response> {
	const changeQuery = options.changeQuery ?? defaultChangesQuery();
	const [config, agents, categories, rawChanges, unrevertedCount] =
		await Promise.all([
			getAdminBotConfig(ctx.env.DB),
			listAgentsWithStatus(ctx.env.DB, ctx.now),
			listCategoriesWithUsage(ctx.env.DB),
			listAdminBotChanges(ctx.env.DB, {
				beforeId: changeQuery.beforeId,
				limit: changeQuery.limit + 1,
				unrevertedOnly: changeQuery.unrevertedOnly,
				targetType: changeQuery.targetType,
			}),
			countUnrevertedAdminBotChanges(ctx.env.DB),
		]);
	const hasOlderChanges = rawChanges.length > changeQuery.limit;
	const changes = rawChanges.slice(0, changeQuery.limit);
	const nextBeforeId = hasOlderChanges ? (changes.at(-1)?.id ?? null) : null;
	const undoAvailability = await inspectAdminBotChangesUndoState(
		ctx.env.DB,
		changes,
	);
	const designated =
		config.agentId !== null
			? (agents.find((item) => item.agent.id === config.agentId) ?? null)
			: null;
	const bodyRecordingEnabled = isBodyRecordingEnabled(auditBodyConfig(ctx.env));

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
				changeQuery,
				hasOlderChanges,
				nextBeforeId,
				unrevertedCount,
				undoAvailability,
				bodyRecordingEnabled,
				now: ctx.now,
				csrfToken: ctx.csrfToken,
				adminMcpUrl: `${ctx.url.origin}/mcp/admin`,
			}),
		},
		options.status ?? 200,
	);
}

async function handleGetAdminBot(ctx: AdminGetContext): Promise<Response> {
	const parsed = parseChangesQuery(ctx.url.searchParams);
	if (!parsed.ok) {
		return renderAdminBotScreen(ctx, {
			status: 400,
			flash: { kind: "error", message: parsed.error },
			changeQuery: parsed.fallback,
		});
	}
	return renderAdminBotScreen(ctx, { changeQuery: parsed.query });
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
		return renderAdminBotScreen(ctx, {
			status: 400,
			flash: {
				kind: "error",
				message: "本文閲覧スイッチの指定が不正です",
			},
		});
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
		return renderAdminBotScreen(ctx, {
			status: statusForError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	if (!result.data.changed) {
		return renderAdminBotScreen(ctx, {
			flash: {
				kind: "info",
				message: enabled
					? "本文閲覧はすでにオンです"
					: "本文閲覧はすでにオフです",
			},
		});
	}

	const bodyRecordingEnabled = isBodyRecordingEnabled(auditBodyConfig(ctx.env));
	const message = enabled
		? bodyRecordingEnabled
			? "本文閲覧をオンにしました"
			: "本文閲覧をオンにしました（監査ログへの本文記録が無効のため、現在読める本文はありません）"
		: "本文閲覧をオフにしました";

	return renderAdminBotScreen(ctx, {
		flash: { kind: "success", message },
	});
}

async function handleSetSuperadmin(ctx: AdminPostContext): Promise<Response> {
	const parsed = parseSuperadminDuration(ctx.form.get("duration"));
	if (parsed === null) {
		return renderAdminBotScreen(ctx, {
			status: 400,
			flash: {
				kind: "error",
				message: "最高管理者権限の有効期間の指定が不正です",
			},
		});
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
		return renderAdminBotScreen(ctx, {
			status: statusForError(result.code),
			flash: { kind: "error", message: result.message },
		});
	}

	if (!result.data.changed) {
		const infoMessage =
			parsed.mode === "off"
				? "最高管理者権限はすでにオフです"
				: parsed.mode === "permanent"
					? "最高管理者権限はすでに無期限で有効です"
					: "最高管理者権限の有効期限は変更されませんでした";
		return renderAdminBotScreen(ctx, {
			flash: { kind: "info", message: infoMessage },
		});
	}

	const successMessage =
		parsed.mode === "off"
			? "最高管理者権限をオフにしました"
			: parsed.mode === "permanent"
				? "最高管理者権限を無期限でオンにしました"
				: `最高管理者権限を ${parsed.days} 日間オンにしました`;

	return renderAdminBotScreen(ctx, {
		flash: { kind: "success", message: successMessage },
	});
}

async function handleRevertAdminBotChange(
	ctx: AdminPostContext,
): Promise<Response> {
	const parsedFilter = parseChangesQuery(ctx.form, "filter_");
	const changeQuery = parsedFilter.ok
		? parsedFilter.query
		: parsedFilter.fallback;

	const rawId = ctx.params.id ?? "";
	if (!/^\d+$/.test(rawId)) {
		return renderAdminBotScreen(ctx, {
			status: 400,
			flash: { kind: "error", message: "変更IDが不正です" },
			changeQuery,
		});
	}
	const changeId = Number(rawId);
	if (!Number.isSafeInteger(changeId) || changeId <= 0) {
		return renderAdminBotScreen(ctx, {
			status: 400,
			flash: { kind: "error", message: "変更IDが不正です" },
			changeQuery,
		});
	}

	const cascade = ctx.form.get("cascade") === "1";
	const result = await revertAdminBotChange(ctx.env.DB, {
		changeId,
		actor: ownerActor(ctx),
		now: ctx.now,
		cascade,
	});
	if (!result.ok) {
		return renderAdminBotScreen(ctx, {
			status: statusForUndoError(result.code),
			flash: { kind: "error", message: result.message },
			changeQuery,
		});
	}

	const revertedIds = result.data.revertedChangeIds;
	const message =
		cascade && revertedIds !== undefined && revertedIds.length > 1
			? `変更 #${result.data.revertedChangeId}（${CHANGE_ACTION_LABELS[result.data.action]}）を含む ${revertedIds.length} 件の変更をまとめて元に戻しました`
			: `変更 #${result.data.revertedChangeId}（${CHANGE_ACTION_LABELS[result.data.action]}）を元に戻しました`;

	return renderAdminBotScreen(ctx, {
		flash: { kind: "success", message },
		changeQuery,
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
			pattern: "/admin/adminbot/permissions/read-bodies",
			post: handleToggleReadBodies,
		},
		{
			pattern: "/admin/adminbot/permissions/superadmin",
			post: handleSetSuperadmin,
		},
		{
			pattern: "/admin/adminbot/changes/:id/revert",
			post: handleRevertAdminBotChange,
		},
	];
}
