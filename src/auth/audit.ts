import { type AuditBodyConfig, recordAuditEvent } from "../audit";
import type { ReasonCode, UnixMillis } from "../types";
import { type AuthFailureReason, auditReasonCode } from "./authenticate";

export type AuthAuditEndpoint = "mcp" | "admin_mcp" | "unread";

export type AuthAuditReason =
	| AuthFailureReason
	| "sender_suspended"
	| "not_admin_bot";

export const AUTH_FAILURE_AUDIT_WINDOW_MS = 60_000;
export const AUTH_FAILURE_AUDIT_MAX_PER_WINDOW = 10;

interface FixedWindowCounter {
	windowId: number;
	count: number;
}

const authFailureWindows = new Map<string, FixedWindowCounter>();

export function resetAuthFailureAuditLimiter(): void {
	authFailureWindows.clear();
}

export function shouldAuditAuthFailure(reason: AuthAuditReason): boolean {
	return reason !== "token_missing" && reason !== "token_malformed";
}

function takeAuthFailureAuditSlot(
	endpoint: AuthAuditEndpoint,
	reason: AuthAuditReason,
	now: UnixMillis,
): boolean {
	if (!Number.isSafeInteger(now)) {
		return false;
	}
	const key = `${endpoint}:${reason}`;
	const windowId = Math.floor(now / AUTH_FAILURE_AUDIT_WINDOW_MS);
	const existing = authFailureWindows.get(key);
	if (existing === undefined || existing.windowId !== windowId) {
		authFailureWindows.set(key, { windowId, count: 1 });
		return true;
	}
	if (existing.count >= AUTH_FAILURE_AUDIT_MAX_PER_WINDOW) {
		return false;
	}
	existing.count += 1;
	return true;
}

export interface AuthFailureAuditInput {
	endpoint: AuthAuditEndpoint;
	reason: AuthAuditReason;
	occurredAt: UnixMillis;
	fromAgentId: string | null;
}

export async function recordAuthFailureAudit(
	db: D1Database,
	config: AuditBodyConfig,
	input: AuthFailureAuditInput,
): Promise<boolean> {
	if (!shouldAuditAuthFailure(input.reason)) {
		return false;
	}
	if (
		!takeAuthFailureAuditSlot(input.endpoint, input.reason, input.occurredAt)
	) {
		return false;
	}
	const reasonCode: ReasonCode =
		input.reason === "sender_suspended" || input.reason === "not_admin_bot"
			? input.reason
			: auditReasonCode(input.reason);
	return recordAuditEvent(db, config, {
		eventType: "auth_failed",
		occurredAt: input.occurredAt,
		fromAgentId: input.fromAgentId,
		reasonCode,
	});
}
