import { type AuditBodyConfig, parseAuditBodyConfig } from "../audit";
import type { WebhookFetcher } from "../notify";

/** The bindings and variables the MCP endpoint and maintenance read. */
export interface McpEnv {
	DB: D1Database;
	AUDIT_RECORD_BODIES?: string;
	AUDIT_BODY_RETENTION_DAYS?: string;
	ALLOW_LOCAL_WEBHOOKS?: string;
	webhookFetcher?: WebhookFetcher;
}

export function auditBodyConfig(env: McpEnv): AuditBodyConfig {
	return parseAuditBodyConfig({
		recordBodies: env.AUDIT_RECORD_BODIES,
		bodyRetentionDays: env.AUDIT_BODY_RETENTION_DAYS,
	});
}
