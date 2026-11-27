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

/** Sentinel value in `admin_bot_config.superadmin_until` meaning permanent superadmin (`null` = off, positive UNIX ms = expires at). */
export const SUPERADMIN_PERMANENT = 0;

/** Default duration in days when enabling superadmin permission (design section 5.3). */
export const DEFAULT_SUPERADMIN_DAYS = 7;

/** Preset durations in days offered in the Admin UI for superadmin permission. */
export const SUPERADMIN_DURATION_PRESETS = [1, 3, 7, 14, 30] as const;

/** Maximum allowed finite duration in days for timed superadmin permission. */
export const MAX_SUPERADMIN_DAYS = 365;

const SUPERADMIN_DAY_MS = 24 * 60 * 60 * 1000;

export type SuperadminState =
	| { kind: "off" }
	| { kind: "permanent" }
	| { kind: "active"; until: UnixMillis; remainingMs: number }
	| { kind: "expired"; expiredAt: UnixMillis };

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

export type SetAdminBotSuperadminInput =
	| { mode: "off"; actor: ChangeActor; now: UnixMillis }
	| { mode: "days"; days?: number; actor: ChangeActor; now: UnixMillis }
	| { mode: "permanent"; actor: ChangeActor; now: UnixMillis };

export type SetAdminBotSwitchesResult =
	| {
			ok: true;
			data: {
				config: AdminBotConfig;
				changed: true;
			};
			changeId: number;
	  }
	| {
			ok: true;
			data: {
				config: AdminBotConfig;
				changed: false;
			};
			changeId: null;
	  }
	| AdminBotFailure;

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
 * revoking active `admin` tokens of previous/other agents, rejecting pending
 * proposals from other agents, resetting optional permission switches, and
 * logging `admin_bot_designated` to `change_log`.
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
					`UPDATE proposals
					SET status = 'rejected', resolved_at = ?1, resolved_by = ?2
					WHERE status = 'pending' AND expires_at > ?1 AND proposer_agent_id <> ?3`,
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
 * tokens, rejecting active pending proposals, and resetting optional permission
 * switches. No-op if already `null`.
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
					`UPDATE proposals
					SET status = 'rejected', resolved_at = ?1, resolved_by = ?2
					WHERE status = 'pending' AND expires_at > ?1`,
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

async function commitAdminBotSwitchUpdate(
	db: D1Database,
	updateStatement: D1PreparedStatement,
	ctx: ValidatedContext,
	expectedAgentId: string,
	before: AdminBotConfig,
	after: AdminBotConfig,
): Promise<SetAdminBotSwitchesResult> {
	const [updateRes, changeRes] = await db.batch([
		updateStatement,
		db
			.prepare(
				`INSERT INTO change_log
					(occurred_at, actor_type, actor_id, approver_id, action,
					target_type, target_id, before_json, after_json, reverted_at)
				SELECT ?, ?, ?, ?, 'admin_bot_switches_updated', 'admin_bot', ?, ?, ?, NULL
				WHERE EXISTS (
					SELECT 1 FROM admin_bot_config WHERE id = 1 AND agent_id = ?
				)`,
			)
			.bind(
				ctx.now,
				ctx.actorType,
				ctx.actorId,
				ctx.approverId,
				expectedAgentId,
				JSON.stringify(before),
				JSON.stringify(after),
				expectedAgentId,
			),
	]);

	if ((updateRes?.meta.changes ?? 0) === 0) {
		return fail(
			"not_admin_bot",
			"管理者ボットの指名が変更されたため権限スイッチを更新できませんでした",
		);
	}

	const changeId = Number(changeRes?.meta.last_row_id);
	if (
		(changeRes?.meta.changes ?? 0) !== 1 ||
		!Number.isSafeInteger(changeId) ||
		changeId <= 0
	) {
		throw new Error("change_log insert did not return a valid last_row_id");
	}

	return {
		ok: true,
		data: { config: after, changed: true },
		changeId,
	};
}

/**
 * Toggles the optional `read_bodies` permission switch for the currently
 * designated administrator bot (design section 5.2, 5.3). Owner-only.
 */
export async function setAdminBotReadBodies(
	db: D1Database,
	input: SetAdminBotReadBodiesInput,
): Promise<SetAdminBotSwitchesResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	if (ctx.value.actorType !== "owner") {
		return adminFail(
			"invalid_input",
			"本文閲覧スイッチの変更は所有者のみが実行できます",
		);
	}
	if (typeof input.enabled !== "boolean") {
		return adminFail("invalid_input", "本文閲覧スイッチの指定が不正です");
	}

	const current = await getAdminBotConfig(db);
	if (current.agentId === null) {
		return fail(
			"not_admin_bot",
			"管理者ボットが指名されていないため権限スイッチを変更できません",
		);
	}

	if (current.readBodies === input.enabled) {
		return {
			ok: true,
			data: { config: current, changed: false },
			changeId: null,
		};
	}

	const next: AdminBotConfig = {
		...current,
		readBodies: input.enabled,
		updatedAt: ctx.value.now,
	};

	return commitAdminBotSwitchUpdate(
		db,
		db
			.prepare(
				`UPDATE admin_bot_config
				SET read_bodies = ?, updated_at = ?
				WHERE id = 1 AND agent_id = ?`,
			)
			.bind(input.enabled ? 1 : 0, ctx.value.now, current.agentId),
		ctx.value,
		current.agentId,
		current,
		next,
	);
}

/**
 * Resolves the current superadmin permission state from `config.superadminUntil`
 * and `now` without waiting for any scheduled sweep (design section 5.3).
 *
 * `null` = off, `0` (`SUPERADMIN_PERMANENT`) = permanent, positive UNIX ms = expires at timestamp.
 */
export function getSuperadminState(
	config: AdminBotConfig,
	now: UnixMillis,
): SuperadminState {
	const until = config.superadminUntil;
	if (until === null) {
		return { kind: "off" };
	}
	if (until === SUPERADMIN_PERMANENT) {
		return { kind: "permanent" };
	}
	if (until > now) {
		return { kind: "active", until, remainingMs: until - now };
	}
	return { kind: "expired", expiredAt: until };
}

/** Returns whether superadmin permission is currently active (timed and not expired, or permanent). */
export function isSuperadminActive(
	config: AdminBotConfig,
	now: UnixMillis,
): boolean {
	const state = getSuperadminState(config, now);
	return state.kind === "permanent" || state.kind === "active";
}

/**
 * Returns `true` only when applying `next` transitions optional permissions
 * from "not both active" to "both `readBodies` and superadmin active at once"
 * (design section 5.3 simultaneous-enable confirmation trigger).
 */
export function wouldEnableBothOptionalPermissions(
	config: AdminBotConfig,
	now: UnixMillis,
	next: { readBodies?: boolean; superadminActive?: boolean },
): boolean {
	const currentSuperadmin = isSuperadminActive(config, now);
	const currentlyBoth = config.readBodies && currentSuperadmin;
	const nextReadBodies = next.readBodies ?? config.readBodies;
	const nextSuperadmin = next.superadminActive ?? currentSuperadmin;
	return !currentlyBoth && nextReadBodies && nextSuperadmin;
}

/**
 * Configures the optional superadmin permission switch for the currently
 * designated administrator bot (design section 5.2, 5.3). Owner-only.
 */
export async function setAdminBotSuperadmin(
	db: D1Database,
	input: SetAdminBotSuperadminInput,
): Promise<SetAdminBotSwitchesResult> {
	const ctx = validateContext(input.actor, input.now);
	if (!ctx.ok) return ctx;

	if (ctx.value.actorType !== "owner") {
		return adminFail(
			"invalid_input",
			"最高管理者権限の変更は所有者のみが実行できます",
		);
	}

	let nextSuperadminUntil: UnixMillis | null;
	if (input.mode === "off") {
		nextSuperadminUntil = null;
	} else if (input.mode === "permanent") {
		nextSuperadminUntil = SUPERADMIN_PERMANENT;
	} else if (input.mode === "days") {
		const days = input.days ?? DEFAULT_SUPERADMIN_DAYS;
		if (
			typeof days !== "number" ||
			!Number.isSafeInteger(days) ||
			days < 1 ||
			days > MAX_SUPERADMIN_DAYS
		) {
			return adminFail(
				"invalid_input",
				`最高管理者権限の有効期間は1〜${MAX_SUPERADMIN_DAYS}日の整数で指定してください`,
			);
		}
		const computed = ctx.value.now + days * SUPERADMIN_DAY_MS;
		if (!Number.isSafeInteger(computed) || computed <= 0) {
			return adminFail(
				"invalid_input",
				"最高管理者権限の有効期限の計算値が不正です",
			);
		}
		nextSuperadminUntil = computed;
	} else {
		return adminFail("invalid_input", "最高管理者権限の指定が不正です");
	}

	const current = await getAdminBotConfig(db);
	if (current.agentId === null) {
		return fail(
			"not_admin_bot",
			"管理者ボットが指名されていないため権限スイッチを変更できません",
		);
	}

	if (current.superadminUntil === nextSuperadminUntil) {
		return {
			ok: true,
			data: { config: current, changed: false },
			changeId: null,
		};
	}

	const next: AdminBotConfig = {
		...current,
		superadminUntil: nextSuperadminUntil,
		updatedAt: ctx.value.now,
	};

	return commitAdminBotSwitchUpdate(
		db,
		db
			.prepare(
				`UPDATE admin_bot_config
				SET superadmin_until = ?, updated_at = ?
				WHERE id = 1 AND agent_id = ?`,
			)
			.bind(nextSuperadminUntil, ctx.value.now, current.agentId),
		ctx.value,
		current.agentId,
		current,
		next,
	);
}
