import type { AuditBodyConfig } from "../audit";
import type { UnixMillis } from "../types";

export type WebhookFetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface NotifyEnv {
	DB: D1Database;
	AUDIT_RECORD_BODIES?: string;
	AUDIT_BODY_RETENTION_DAYS?: string;
	ALLOW_LOCAL_WEBHOOKS?: string;
	webhookFetcher?: WebhookFetcher;
}

export type WebhookUrlValidation =
	| { ok: true; url: string }
	| { ok: false; message: string };

export interface EnqueueWebhookOptions {
	agentId: string;
	now: UnixMillis;
	immediate: boolean;
}

export interface EnqueueWebhookResult {
	deliveryId: string | null;
	shouldDispatchNow: boolean;
}

export interface WebhookDispatchOptions {
	now: UnixMillis;
	audit: AuditBodyConfig;
	allowLocal: boolean;
	fetcher?: WebhookFetcher;
}

export interface WebhookAttemptResult {
	deliveryId: string;
	agentId: string;
	status: "delivered" | "pending" | "abandoned" | "skipped";
	attempts: number;
	lastError: string | null;
}

export interface ProcessWebhooksResult {
	processed: number;
	delivered: number;
	retried: number;
	abandoned: number;
}
