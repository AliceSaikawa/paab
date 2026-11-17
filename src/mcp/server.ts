import { McpServer } from "@modelcontextprotocol/server";
import { countUnread } from "../inbox";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { type McpContext, TOOLS } from "./tools";

/**
 * Builds the MCP server for one request by one agent. Every tool result,
 * failures included, ends with the caller's unread count after the call
 * (design 2.3).
 */
export function createMcpServer(ctx: McpContext): McpServer {
	const server = new McpServer(
		{ name: "paab", version: "0.0.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);
	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.inputSchema },
			async (args) => {
				const output = await tool.run(ctx, args);
				const unread = await countUnread(ctx.db, ctx.agent.id, ctx.now);
				return {
					content: [
						{
							type: "text",
							text: `${output.text}\n\nunread_messages: ${unread}`,
						},
					],
					isError: output.isError,
				};
			},
		);
	}
	return server;
}
