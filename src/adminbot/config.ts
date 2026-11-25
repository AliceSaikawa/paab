import {
	type AdminErrorCode,
	type ChangeActor,
	type IssuedAgentToken,
	issueAgentToken,
	type RevokeAgentTokensResult,
	revokeAgentTokens,
} from "../admin";
import {
	fail as adminFail,
	runWithChangeLog,
	type ValidatedContext,
	validateContext,
	validateId,
} from "../admin/validate";
import {
	type AdminBotConfigRow,
	type AgentRow,
	adminBotConfigFromRow,
	agentFromRow,
} from "../db";
import type { AdminBotConfig, Agent, UnixMillis } from "../types";

export type { AdminBotConfig };

const DAY_MS = 24 * 60 * 60 * 1000;

export const SUPERADMIN_UNLIMITED = -1;

export const SUPERADMIN_DURATION_MODES = [
	"1d",
	"7d",
	"30d",
	"unlimited",
] as const;
export type SuperadminDurationMode = (typeof SUPERADMIN_DURATION_MODES)[number];

export const SUPERADMIN_MODES = ["off", ...SUPERADMIN_DURATION_MODES] as const;
export type SuperadminMode = (typeof SUPERADMIN_MODES)[number];

export const DEFAULT_SUPERADMIN_MODE: SuperadminDurationMode = "7d";

export const SUPERADMIN_DURATION_MS: Record<
	Exclude<SuperadminDurationMode, "unlimited">,
	number
> = {
	"1d": 1 * DAY_MS,
	"7d": 7 * DAY_MS,
	"30d": 30 * DAY_MS,
};

/** Returns whether superadmin permission is active at `now` (`-1` means unlimited). */
export function isSuperadminActive(
	config: Pick<AdminBotConfig, "superadminUntil">,
	now: UnixMillis,
): boolean {
	return (
		config.superadminUntil === SUPERADMIN_UNLIMITED ||
		(config.superadminUntil !== null && config.superadminUntil > now)
	);
}

export type AdminBotErrorCode = AdminErrorCode | "not_admin_bot";

export interface AdminBotFailure {
	ok: false;
	code: AdminBotErrorCode;
	message: string;
}

export type AdminBotResult<T, C extends number | null = number> =
	| { ok: true; data: T; changeId: C }
	| AdminBotFailure;

export interface DesignateAdminBotInput {
	agentId: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export type DesignateAdminBotResult =
	| {
			ok: true;
			data: {
				config: AdminBotConfig;
				agent: Agent;
				previousAgentId: string | null;
				changed: true;
			};
			changeId: number;
	  }
	| {
			ok: true;
			data: {
				config: AdminBotConfig;
				agent: Agent;
				previousAgentId: string | null;
				changed: false;
			};
			changeId: null;
	  }
	| AdminBotFailure;

export interface ClearAdminBotInput {
	actor: ChangeActor;
	now: UnixMillis;
}

export type ClearAdminBotResult =
	| {
			ok: true;
			data: {
				config: AdminBotConfig;
				previousAgentId: string;
				changed: true;
			};
			changeId: number;
	  }
	| {
			ok: true;
			data: {
				config: AdminBotConfig;
				previousAgentId: null;
				changed: false;
			};
			changeId: null;
	  }
	| AdminBotFailure;

export interface AdminBotTokenInput {
	agentId: string;
	actor: ChangeActor;
	now: UnixMillis;
}

export interface SetAdminBotReadBodiesInput {
	enabled: boolean;
	actor: ChangeActor;
	now: UnixMillis;
}

export type SetAdminBotReadBodiesResult =
	| {
			ok: true;
			data: { config: AdminBotConfig; changed: true };
			changeId: number;
	  }
	| {
			ok: true;
			data: { config: AdminBotConfig; changed: false };
			changeId: null;
	  }
	| AdminBotFailure;

export interface SetAdminBotSuperadminInput {
	mode: SuperadminMode;
	actor: ChangeActor;
	now: UnixMillis;
}

export type SetAdminBotSuperadminResult = SetAdminBotReadBodiesResult;

export type RevokeAdminBotTokenResult =
	| RevokeAgentTokensResult
	| AdminBotFailure;

const DEFAULT_CONFIG: AdminBotConfig = {
	agentId: null,
	readBodies: false,
	superadminUntil: null,
	updatedAt: 0,
};

function fail(code: AdminBotErrorCode, message: string): AdminBotFailure {
	return { ok: false, code, message };
}

/**
 * Returns the current administrator bot configuration, or the unconfigured
 * default if row `id = 1` does not exist yet.
 */
export async function getAdminBotConfig(
	db: D1Database,
): Promise<AdminBotConfig> {
	const row = await db
		.prepare("SELECT * FROM admin_bot_config WHERE id = 1")
		.first<AdminBotConfigRow>();
	return row !== null ? adminBotConfigFromRow(row) : { ...DEFAULT_CONFIG };
}

/**
 * Designates an existing agent as the single administrator bot, atomically
 * revoking active `admin` tokens of previous/other agents, rejecting any
 * remaining `pending` proposals of previous/other bots, resetting optional
 * permission switches, and logging `admin_bot_designated` to `change_log`.
 */
export async function designateAdminBot(
	db: D1Database,
	input: DesignateAdminBotInput,
): Promise<DesignateAdminBotResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const [agentResult, configResult] = await db.batch([
		db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId.value),
		db.prepare("SELECT * FROM admin_bot_config WHERE id = 1"),
	]);
	const agentRow = (agentResult?.results[0] ?? null) as AgentRow | null;
	if (agentRow === null) {
		return adminFail("not_found", "指定されたエージェントが見つかりません");
	}
	const agent = agentFromRow(agentRow);
	const configRow = (configResult?.results[0] ??
		null) as AdminBotConfigRow | null;
	const current =
		configRow !== null
			? adminBotConfigFromRow(configRow)
			: { ...DEFAULT_CONFIG };

	if (current.agentId === agent.id) {
		return {
			ok: true,
			data: {
				config: current,
				agent,
				previousAgentId: current.agentId,
				changed: false,
			},
			changeId: null,
		};
	}

	const next: AdminBotConfig = {
		agentId: agent.id,
		readBodies: false,
		superadminUntil: null,
		updatedAt: ctx.value.now,
	};

	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare(
					`UPDATE tokens SET revoked_at = ?
					WHERE purpose = 'admin' AND revoked_at IS NULL AND agent_id <> ?`,
				)
				.bind(ctx.value.now, agent.id),
			db
				.prepare(
					`UPDATE proposals SET status = 'rejected', resolved_at = ?, resolved_by = ?
					WHERE status = 'pending' AND bot_agent_id <> ?`,
				)
				.bind(ctx.value.now, ctx.value.actorId, agent.id),
			db
				.prepare(
					`INSERT INTO admin_bot_config (id, agent_id, read_bodies, superadmin_until, updated_at)
					VALUES (1, ?, 0, NULL, ?)
					ON CONFLICT (id) DO UPDATE SET
						agent_id = excluded.agent_id,
						read_bodies = 0,
						superadmin_until = NULL,
						updated_at = excluded.updated_at`,
				)
				.bind(agent.id, ctx.value.now),
		],
		{
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "admin_bot_designated",
			targetType: "admin_bot",
			targetId: agent.id,
			beforeJson: JSON.stringify(current),
			afterJson: JSON.stringify(next),
			revertedAt: null,
		},
	);

	return {
		ok: true,
		data: {
			config: next,
			agent,
			previousAgentId: current.agentId,
			changed: true,
		},
		changeId,
	};
}

/**
 * Clears the current administrator bot designation, revoking active `admin`
 * tokens, rejecting any remaining `pending` proposals, and resetting optional
 * permission switches. No-op if already `null`.
 */
export async function clearAdminBot(
	db: D1Database,
	input: ClearAdminBotInput,
): Promise<ClearAdminBotResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const current = await getAdminBotConfig(db);
	if (current.agentId === null) {
		return {
			ok: true,
			data: { config: current, previousAgentId: null, changed: false },
			changeId: null,
		};
	}

	const previousAgentId = current.agentId;
	const next: AdminBotConfig = {
		agentId: null,
		readBodies: false,
		superadminUntil: null,
		updatedAt: ctx.value.now,
	};

	const changeId = await runWithChangeLog(
		db,
		[
			db
				.prepare(
					`UPDATE tokens SET revoked_at = ?
					WHERE purpose = 'admin' AND revoked_at IS NULL`,
				)
				.bind(ctx.value.now),
			db
				.prepare(
					`UPDATE proposals SET status = 'rejected', resolved_at = ?, resolved_by = ?
					WHERE status = 'pending'`,
				)
				.bind(ctx.value.now, ctx.value.actorId),
			db
				.prepare(
					`UPDATE admin_bot_config
					SET agent_id = NULL, read_bodies = 0, superadmin_until = NULL, updated_at = ?
					WHERE id = 1`,
				)
				.bind(ctx.value.now),
		],
		{
			occurredAt: ctx.value.now,
			actorType: ctx.value.actorType,
			actorId: ctx.value.actorId,
			approverId: ctx.value.approverId,
			action: "admin_bot_cleared",
			targetType: "admin_bot",
			targetId: previousAgentId,
			beforeJson: JSON.stringify(current),
			afterJson: JSON.stringify(next),
			revertedAt: null,
		},
	);

	return {
		ok: true,
		data: { config: next, previousAgentId, changed: true },
		changeId,
	};
}

async function verifyDesignatedAdminAgent(
	db: D1Database,
	agentId: string,
): Promise<AdminBotFailure | null> {
	const [agentResult, configResult] = await db.batch([
		db.prepare("SELECT id FROM agents WHERE id = ?").bind(agentId),
		db.prepare("SELECT * FROM admin_bot_config WHERE id = 1"),
	]);
	if ((agentResult?.results.length ?? 0) === 0) {
		return adminFail("not_found", "指定されたエージェントが見つかりません");
	}
	const configRow = (configResult?.results[0] ??
		null) as AdminBotConfigRow | null;
	const config =
		configRow !== null
			? adminBotConfigFromRow(configRow)
			: { ...DEFAULT_CONFIG };
	if (config.agentId !== agentId) {
		return fail(
			"not_admin_bot",
			"現在指名されている管理者ボットに対してのみ管理者トークンを操作できます",
		);
	}
	return null;
}

/**
 * Issues (or reissues) the `purpose = "admin"` token for the currently
 * designated administrator bot. Refuses if `agentId` is not designated.
 */
export async function issueAdminBotToken(
	db: D1Database,
	input: AdminBotTokenInput,
): Promise<AdminBotResult<IssuedAgentToken>> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const check = await verifyDesignatedAdminAgent(db, agentId.value);
	if (check !== null) return check;

	return issueAgentToken(db, {
		agentId: agentId.value,
		purpose: "admin",
		actor: input.actor,
		now: input.now,
	});
}

/**
 * Revokes the active `purpose = "admin"` token of the currently designated
 * administrator bot. Refuses if `agentId` is not designated.
 */
export async function revokeAdminBotToken(
	db: D1Database,
	input: AdminBotTokenInput,
): Promise<RevokeAdminBotTokenResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	const agentId = validateId(input.agentId, "エージェントID");
	if (!agentId.ok) return agentId;

	const check = await verifyDesignatedAdminAgent(db, agentId.value);
	if (check !== null) return check;

	return revokeAgentTokens(db, {
		agentId: agentId.value,
		purpose: "admin",
		actor: input.actor,
		now: input.now,
	});
}

async function applyAdminBotSwitchChange(
	db: D1Database,
	agentId: string,
	current: AdminBotConfig,
	next: AdminBotConfig,
	ctx: ValidatedContext,
): Promise<number> {
	return runWithChangeLog(
		db,
		[
			db
				.prepare(
					`UPDATE admin_bot_config
					SET read_bodies = ?, superadmin_until = ?, updated_at = ?
					WHERE id = 1`,
				)
				.bind(next.readBodies ? 1 : 0, next.superadminUntil, ctx.now),
		],
		{
			occurredAt: ctx.now,
			actorType: ctx.actorType,
			actorId: ctx.actorId,
			approverId: ctx.approverId,
			action: "admin_bot_switches_updated",
			targetType: "admin_bot",
			targetId: agentId,
			beforeJson: JSON.stringify(current),
			afterJson: JSON.stringify(next),
			revertedAt: null,
		},
	);
}

/**
 * Enables or disables `read_bodies` for the currently designated administrator
 * bot, updating `admin_bot_config` and logging `admin_bot_switches_updated`
 * in one `db.batch`. No-op if already matching `enabled`.
 */
export async function setAdminBotReadBodies(
	db: D1Database,
	input: SetAdminBotReadBodiesInput,
): Promise<SetAdminBotReadBodiesResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	if (typeof input.enabled !== "boolean") {
		return adminFail(
			"invalid_input",
			"本文閲覧の設定値は真偽値で指定してください",
		);
	}

	const current = await getAdminBotConfig(db);
	if (current.agentId === null) {
		return fail("not_admin_bot", "管理者ボットが指名されていません");
	}

	if (current.readBodies === input.enabled) {
		return {
			ok: true,
			data: { config: current, changed: false },
			changeId: null,
		};
	}

	const next: AdminBotConfig = {
		agentId: current.agentId,
		readBodies: input.enabled,
		superadminUntil: current.superadminUntil,
		updatedAt: ctx.value.now,
	};

	const changeId = await applyAdminBotSwitchChange(
		db,
		current.agentId,
		current,
		next,
		ctx.value,
	);

	return {
		ok: true,
		data: { config: next, changed: true },
		changeId,
	};
}

function resolveSuperadminUntil(
	mode: SuperadminMode,
	now: UnixMillis,
): UnixMillis | null {
	switch (mode) {
		case "off":
			return null;
		case "unlimited":
			return SUPERADMIN_UNLIMITED;
		case "1d":
		case "7d":
		case "30d":
			return now + SUPERADMIN_DURATION_MS[mode];
	}
}

/**
 * Updates `superadmin_until` for the currently designated administrator bot and
 * logs `admin_bot_switches_updated` in one `db.batch`. No-op if the stored
 * expiry already equals the target value.
 */
export async function setAdminBotSuperadmin(
	db: D1Database,
	input: SetAdminBotSuperadminInput,
): Promise<SetAdminBotSuperadminResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	if (!(SUPERADMIN_MODES as readonly string[]).includes(input.mode)) {
		return adminFail("invalid_input", "最高管理者権限の設定値が不正です");
	}

	const current = await getAdminBotConfig(db);
	if (current.agentId === null) {
		return fail("not_admin_bot", "管理者ボットが指名されていません");
	}

	const nextUntil = resolveSuperadminUntil(input.mode, ctx.value.now);
	if (current.superadminUntil === nextUntil) {
		return {
			ok: true,
			data: { config: current, changed: false },
			changeId: null,
		};
	}

	const next: AdminBotConfig = {
		agentId: current.agentId,
		readBodies: current.readBodies,
		superadminUntil: nextUntil,
		updatedAt: ctx.value.now,
	};

	const changeId = await applyAdminBotSwitchChange(
		db,
		current.agentId,
		current,
		next,
		ctx.value,
	);

	return {
		ok: true,
		data: { config: next, changed: true },
		changeId,
	};
}
