import { handleAdminMcpRequest } from "./adminbot";
import { handleMcpRequest, runScheduledMaintenance } from "./mcp";
import { handleAdminRequest } from "./ui";

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return new Response("ok", { status: 200 });
		}
		if (url.pathname === "/mcp") {
			return handleMcpRequest(request, env, Date.now());
		}
		if (url.pathname === "/mcp/admin") {
			return handleAdminMcpRequest(request, env, Date.now());
		}
		if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
			return handleAdminRequest(request, env, Date.now());
		}
		return new Response("Not Found", { status: 404 });
	},

	async scheduled(
		_event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(runScheduledMaintenance(env, Date.now()));
	},
};
