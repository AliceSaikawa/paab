import { createMcpHandler } from "@modelcontextprotocol/server";
import { authenticate, recordAuthFailureAudit } from "../auth";
import type { WebhookFetcher } from "../notify";
import type { UnixMillis } from "../types";
import {
	allowInsecureLocalhostWebhook,
	auditBodyConfig,
	type McpEnv,
} from "./config";
import { createMcpServer } from "./server";
import type { McpContext } from "./tools";

export interface McpRequestOptions {
	waitUntil?: (promise: Promise<unknown>) => void;
	webhookFetcher?: WebhookFetcher;
}

/**
 * Serves one HTTP request to `/mcp`. Nothing is kept between requests: the
 * caller is authenticated from its token every time and gets a fresh server
 * bound to it.
 */
export async function handleMcpRequest(
	request: Request,
	env: McpEnv,
	now: UnixMillis,
	options?: McpRequestOptions,
): Promise<Response> {
	const db = env.DB;
	const audit = auditBodyConfig(env);
	const auth = await authenticate(
		db,
		request.headers.get("Authorization"),
		"participant",
	);

	if (!auth.ok) {
		await recordAuthFailureAudit(db, audit, {
			endpoint: "mcp",
			reason: auth.reason,
			occurredAt: now,
			fromAgentId: auth.agentId,
		});
		// Every failure looks the same to the client; the reason is in the audit log.
		return new Response(null, {
			status: 401,
			headers: { "WWW-Authenticate": "Bearer" },
		});
	}
	if (auth.suspended) {
		await recordAuthFailureAudit(db, audit, {
			endpoint: "mcp",
			reason: "sender_suspended",
			occurredAt: now,
			fromAgentId: auth.agent.id,
		});
		return new Response("agent suspended", { status: 403 });
	}

	const ctx: McpContext = {
		db,
		agent: auth.agent,
		audit,
		now,
		waitUntil: options?.waitUntil,
		webhookFetcher: options?.webhookFetcher,
		allowInsecureLocalhostWebhook: allowInsecureLocalhostWebhook(env),
	};
	return createMcpHandler(() => createMcpServer(ctx)).fetch(request);
}
