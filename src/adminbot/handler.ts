import { createMcpHandler } from "@modelcontextprotocol/server";
import { authenticate, recordAuthFailureAudit } from "../auth";
import { auditBodyConfig, type McpEnv } from "../mcp/config";
import type { UnixMillis } from "../types";
import { getAdminBotConfig } from "./config";
import { createAdminMcpServer } from "./server";
import type { AdminMcpContext } from "./tools";

/**
 * Serves one HTTP request to `/mcp/admin`. Authenticates with a `purpose = "admin"`
 * bearer token, verifies the caller is active and currently designated as the
 * single administrator bot, and binds a stateless MCP server for that request.
 */
export async function handleAdminMcpRequest(
	request: Request,
	env: McpEnv,
	now: UnixMillis,
): Promise<Response> {
	const db = env.DB;
	const audit = auditBodyConfig(env);
	const auth = await authenticate(
		db,
		request.headers.get("Authorization"),
		"admin",
	);

	if (!auth.ok) {
		await recordAuthFailureAudit(db, audit, {
			endpoint: "admin_mcp",
			reason: auth.reason,
			occurredAt: now,
			fromAgentId: auth.agentId,
		});
		return new Response(null, {
			status: 401,
			headers: { "WWW-Authenticate": "Bearer" },
		});
	}

	if (auth.suspended) {
		await recordAuthFailureAudit(db, audit, {
			endpoint: "admin_mcp",
			reason: "sender_suspended",
			occurredAt: now,
			fromAgentId: auth.agent.id,
		});
		return new Response("agent suspended", { status: 403 });
	}

	const config = await getAdminBotConfig(db);
	if (config.agentId !== auth.agent.id) {
		await recordAuthFailureAudit(db, audit, {
			endpoint: "admin_mcp",
			reason: "not_admin_bot",
			occurredAt: now,
			fromAgentId: auth.agent.id,
		});
		return new Response("not designated admin bot", { status: 403 });
	}

	const ctx: AdminMcpContext = {
		db,
		agent: auth.agent,
		config,
		audit,
		now,
	};
	return createMcpHandler(() => createAdminMcpServer(ctx)).fetch(request);
}
