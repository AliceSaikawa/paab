import { insertChangeLogEntry } from "../db";
import {
	descriptionProblem,
	nameProblem,
	normalizeDescription,
	normalizeName,
} from "../policy";
import {
	AGENT_STATUSES,
	type AgentStatus,
	CHANGE_ACTOR_TYPES,
	type ChangeActorType,
	type NewChangeLogEntry,
	TOKEN_PURPOSES,
	type TokenPurpose,
	type UnixMillis,
} from "../types";
import type { AdminErrorCode, AdminFailure, ChangeActor } from "./types";

export interface ValidatedContext {
	actorType: ChangeActorType;
	actorId: string;
	approverId: string | null;
	now: UnixMillis;
}

type Check<T> = { ok: true; value: T } | AdminFailure;

export function fail(code: AdminErrorCode, message: string): AdminFailure {
	return { ok: false, code, message };
}

export function validateContext(
	actor: ChangeActor,
	now: UnixMillis,
): Check<ValidatedContext> {
	if (!Number.isSafeInteger(now)) {
		return fail("invalid_input", "時刻は整数で指定してください");
	}
	if (!(CHANGE_ACTOR_TYPES as readonly string[]).includes(actor.actorType)) {
		return fail("invalid_input", "操作者種別が不正です");
	}
	if (typeof actor.actorId !== "string" || actor.actorId.trim().length === 0) {
		return fail("invalid_input", "操作者IDを指定してください");
	}
	if (
		actor.approverId !== undefined &&
		actor.approverId !== null &&
		(typeof actor.approverId !== "string" ||
			actor.approverId.trim().length === 0)
	) {
		return fail("invalid_input", "承認者IDが不正です");
	}
	return {
		ok: true,
		value: {
			actorType: actor.actorType,
			actorId: actor.actorId.trim(),
			approverId: actor.approverId ? actor.approverId.trim() : null,
			now,
		},
	};
}

export function validateId(value: string, label: string): Check<string> {
	if (typeof value !== "string" || value.trim().length === 0) {
		return fail("invalid_input", `${label}を指定してください`);
	}
	return { ok: true, value };
}

export function validateName(raw: string): Check<string> {
	if (typeof raw !== "string") {
		return fail("invalid_name", "名前は文字列で指定してください");
	}
	const problem = nameProblem(raw);
	if (problem !== null) {
		return fail("invalid_name", problem);
	}
	return { ok: true, value: normalizeName(raw) };
}

export function validateDescription(raw: string): Check<string> {
	if (typeof raw !== "string") {
		return fail("invalid_description", "説明文は文字列で指定してください");
	}
	const problem = descriptionProblem(raw);
	if (problem !== null) {
		return fail("invalid_description", problem);
	}
	return { ok: true, value: normalizeDescription(raw) };
}

export function validateDailyLimit(value: number): Check<number> {
	if (!Number.isSafeInteger(value) || value < 0) {
		return fail(
			"invalid_limit",
			"1日あたりの質問数上限は0以上の整数にしてください",
		);
	}
	return { ok: true, value };
}

export function validateOwnerId(raw: string): Check<string> {
	if (typeof raw !== "string") {
		return fail("invalid_input", "所有者IDは文字列で指定してください");
	}
	const problem = nameProblem(raw);
	if (problem !== null) {
		return fail("invalid_input", `所有者IDが不正です: ${problem}`);
	}
	return { ok: true, value: normalizeName(raw) };
}

export function validateAgentStatus(status: AgentStatus): Check<AgentStatus> {
	if (!(AGENT_STATUSES as readonly string[]).includes(status)) {
		return fail("invalid_input", "エージェント状態が不正です");
	}
	return { ok: true, value: status };
}

export function validateTokenPurpose(
	purpose: TokenPurpose,
): Check<TokenPurpose> {
	if (!(TOKEN_PURPOSES as readonly string[]).includes(purpose)) {
		return fail("invalid_input", "トークン用途が不正です");
	}
	return { ok: true, value: purpose };
}

export function isUniqueConstraintError(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes("UNIQUE constraint failed")
	);
}

/**
 * Runs D1 mutation statements and the corresponding change_log insert in one
 * transaction, returning the new change_log ID.
 */
export async function runWithChangeLog(
	db: D1Database,
	statements: D1PreparedStatement[],
	entry: NewChangeLogEntry,
): Promise<number> {
	const results = await db.batch([
		...statements,
		insertChangeLogEntry(db, entry),
	]);
	const changeResult = results.at(-1);
	const changeId = Number(changeResult?.meta.last_row_id);
	if (!Number.isSafeInteger(changeId) || changeId <= 0) {
		throw new Error("change_log insert did not return a valid last_row_id");
	}
	return changeId;
}
