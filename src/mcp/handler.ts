import { createMcpHandler } from "@modelcontextprotocol/server";
import { recordAuditEvent } from "../audit";
import { auditReasonCode, authenticate } from "../auth";
import { isLocalWebhookAllowed } from "../notify";
import type { UnixMillis } from "../types";
import { auditBodyConfig, type McpEnv } from "./config";
import { createMcpServer } from "./server";
import type { McpContext } from "./tools";

/**
 * Serves one HTTP request to `/mcp`. Nothing is kept between requests: the
 * caller is authenticated from its token every time and gets a fresh server
 * bound to it.
 */
export async function handleMcpRequest(
	request: Request,
	env: McpEnv,
	now: UnixMillis,
	executionCtx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
	const db = env.DB;
	const audit = auditBodyConfig(env);
	const auth = await authenticate(
		db,
		request.headers.get("Authorization"),
		"participant",
	);

	if (!auth.ok) {
		await recordAuditEvent(db, audit, {
			eventType: "auth_failed",
			occurredAt: now,
			fromAgentId: auth.agentId,
			reasonCode: auditReasonCode(auth.reason),
		});
		// Every failure looks the same to the client; the reason is in the audit log.
		return new Response(null, {
			status: 401,
			headers: { "WWW-Authenticate": "Bearer" },
		});
	}
	if (auth.suspended) {
		await recordAuditEvent(db, audit, {
			eventType: "auth_failed",
			occurredAt: now,
			fromAgentId: auth.agent.id,
			reasonCode: "sender_suspended",
		});
		return new Response("agent suspended", { status: 403 });
	}

	const ctx: McpContext = {
		db,
		agent: auth.agent,
		audit,
		now,
		allowLocalWebhooks: isLocalWebhookAllowed(env),
		webhookFetcher: env.webhookFetcher,
		executionCtx,
	};
	return createMcpHandler(() => createMcpServer(ctx)).fetch(request);
}
