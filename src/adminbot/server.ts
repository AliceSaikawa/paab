import { McpServer } from "@modelcontextprotocol/server";
import { countRecentAdminBotMutations } from "../admin";
import { recordAuditEvent } from "../audit";
import { DEFAULT_ADMIN_BOT_HOURLY_MUTATION_LIMIT } from "../mcp/config";
import { ADMIN_SERVER_INSTRUCTIONS } from "./instructions";
import {
	ADMIN_TOOLS,
	type AdminMcpContext,
	type AdminToolDefinition,
} from "./tools";

/**
 * Builds the administrator MCP server for one authenticated request on
 * `/mcp/admin`. Tools come from a shared registry (`ADMIN_TOOLS`) so follow-up
 * units (`3b`–`3f`) can append tools without changing connection plumbing.
 */
export function createAdminMcpServer(
	ctx: AdminMcpContext,
	tools: readonly AdminToolDefinition[] = ADMIN_TOOLS,
): McpServer {
	const server = new McpServer(
		{ name: "paab-admin", version: "0.0.0" },
		{ instructions: ADMIN_SERVER_INSTRUCTIONS },
	);
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.inputSchema },
			async (args) => {
				if (tool.mutating) {
					const limit =
						ctx.hourlyMutationLimit ?? DEFAULT_ADMIN_BOT_HOURLY_MUTATION_LIMIT;
					const recentMutations = await countRecentAdminBotMutations(
						ctx.db,
						ctx.now,
					);
					if (recentMutations >= limit) {
						await recordAuditEvent(ctx.db, ctx.audit, {
							eventType: "admin_tool_denied",
							occurredAt: ctx.now,
							fromAgentId: ctx.agent.id,
							reasonCode: "admin_rate_limit_exceeded",
						});
						return {
							content: [
								{
									type: "text",
									text: `admin bot hourly mutation limit exceeded (${limit} per hour); try again later or ask the owner to adjust ADMIN_BOT_HOURLY_MUTATION_LIMIT`,
								},
							],
							isError: true,
						};
					}
				}

				const output = await tool.run(ctx, args);
				if (output.audit?.deniedReason !== undefined) {
					await recordAuditEvent(ctx.db, ctx.audit, {
						eventType: "admin_tool_denied",
						occurredAt: ctx.now,
						fromAgentId: ctx.agent.id,
						toAgentId: output.audit.toAgentId ?? null,
						categoryId: output.audit.categoryId ?? null,
						messageId: output.audit.messageId ?? null,
						reasonCode: output.audit.deniedReason,
					});
				} else if (!output.isError) {
					await recordAuditEvent(ctx.db, ctx.audit, {
						eventType: "admin_tool_called",
						occurredAt: ctx.now,
						fromAgentId: ctx.agent.id,
						toAgentId: output.audit?.toAgentId ?? null,
						categoryId: output.audit?.categoryId ?? null,
						messageId: output.audit?.messageId ?? null,
					});
				}
				return {
					content: [{ type: "text", text: output.text }],
					isError: output.isError,
				};
			},
		);
	}
	return server;
}
