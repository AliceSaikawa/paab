import { type AuditBodyConfig, parseAuditBodyConfig } from "../audit";

/** Default rolling 1-hour limit on mutating `/mcp/admin` tool calls. */
export const DEFAULT_ADMIN_BOT_HOURLY_MUTATION_LIMIT = 60;

/** The bindings and variables the MCP endpoint and maintenance read. */
export interface McpEnv {
	DB: D1Database;
	AUDIT_RECORD_BODIES?: string;
	AUDIT_BODY_RETENTION_DAYS?: string;
	WEBHOOK_ALLOW_INSECURE_LOCALHOST?: string;
	ADMIN_BOT_HOURLY_MUTATION_LIMIT?: string;
}

export function auditBodyConfig(env: McpEnv): AuditBodyConfig {
	return parseAuditBodyConfig({
		recordBodies: env.AUDIT_RECORD_BODIES,
		bodyRetentionDays: env.AUDIT_BODY_RETENTION_DAYS,
	});
}

export function allowInsecureLocalhostWebhook(env: McpEnv): boolean {
	return env.WEBHOOK_ALLOW_INSECURE_LOCALHOST?.trim().toLowerCase() === "true";
}

export function adminBotHourlyMutationLimit(env: McpEnv): number {
	const raw = env.ADMIN_BOT_HOURLY_MUTATION_LIMIT;
	if (raw === undefined) {
		return DEFAULT_ADMIN_BOT_HOURLY_MUTATION_LIMIT;
	}
	if (/^\s*[0-9]+\s*$/.test(raw)) {
		const parsed = Number(raw);
		if (Number.isSafeInteger(parsed)) {
			return parsed;
		}
	}
	return DEFAULT_ADMIN_BOT_HOURLY_MUTATION_LIMIT;
}
