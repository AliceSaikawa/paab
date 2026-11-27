import { authenticate, recordAuthFailureAudit } from "../auth";
import { countUnread } from "../inbox";
import { auditBodyConfig, type McpEnv } from "../mcp/config";
import type { UnixMillis } from "../types";

/**
 * Serves one HTTP request to `GET /unread`.
 *
 * Authenticates strictly from the `Authorization: Bearer <token>` header with
 * `purpose = "unread_count"` (never from URL query parameters), verifies the
 * agent is not suspended, and returns `{"unread": N}` without marking messages
 * received.
 */
export async function handleUnreadRequest(
	request: Request,
	env: McpEnv,
	now: UnixMillis,
): Promise<Response> {
	if (request.method !== "GET") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: {
				Allow: "GET",
				"Cache-Control": "no-store",
			},
		});
	}

	const db = env.DB;
	const audit = auditBodyConfig(env);
	const auth = await authenticate(
		db,
		request.headers.get("Authorization"),
		"unread_count",
	);

	if (!auth.ok) {
		await recordAuthFailureAudit(db, audit, {
			endpoint: "unread",
			reason: auth.reason,
			occurredAt: now,
			fromAgentId: auth.agentId,
		});
		return new Response(null, {
			status: 401,
			headers: {
				"WWW-Authenticate": "Bearer",
				"Cache-Control": "no-store",
			},
		});
	}

	if (auth.suspended) {
		await recordAuthFailureAudit(db, audit, {
			endpoint: "unread",
			reason: "sender_suspended",
			occurredAt: now,
			fromAgentId: auth.agent.id,
		});
		return new Response("agent suspended", {
			status: 403,
			headers: { "Cache-Control": "no-store" },
		});
	}

	const unread = await countUnread(db, auth.agent.id, now);
	return new Response(JSON.stringify({ unread }), {
		status: 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
