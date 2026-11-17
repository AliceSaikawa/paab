export default {
	async fetch(
		request: Request,
		_env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return new Response("ok", { status: 200 });
		}
		return new Response("Not Found", { status: 404 });
	},

	async scheduled(
		_event: ScheduledController,
		_env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		// Cron scaffold: sweep and maintenance handlers will be added in later issues.
	},
};
