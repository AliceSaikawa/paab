import {
	type AuditBodyConfig,
	parseAuditBodyConfig,
	parseAuditLogRetentionDays,
} from "../audit";

/** The bindings and variables the MCP endpoint and maintenance read. */
export interface McpEnv {
	DB: D1Database;
	AUDIT_RECORD_BODIES?: string;
	AUDIT_BODY_RETENTION_DAYS?: string;
	AUDIT_LOG_RETENTION_DAYS?: string;
	WEBHOOK_ALLOW_INSECURE_LOCALHOST?: string;
}

export function auditBodyConfig(env: McpEnv): AuditBodyConfig {
	return parseAuditBodyConfig({
		recordBodies: env.AUDIT_RECORD_BODIES,
		bodyRetentionDays: env.AUDIT_BODY_RETENTION_DAYS,
	});
}

export function auditLogRetentionDays(env: McpEnv): number {
	return parseAuditLogRetentionDays(env.AUDIT_LOG_RETENTION_DAYS);
}

export function allowInsecureLocalhostWebhook(env: McpEnv): boolean {
	return env.WEBHOOK_ALLOW_INSECURE_LOCALHOST?.trim().toLowerCase() === "true";
}
