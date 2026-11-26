import type { UnixMillis } from "../types";
import {
	type AccessUser,
	type JwksFetcher,
	type UiEnv,
	verifyAccessRequest,
} from "./access";
import { adminBotRoutes } from "./adminbot";
import { agentRoutes } from "./agents";
import { auditRoutes } from "./audit";
import { prepareCsrfGet, verifyCsrfPost } from "./csrf";
import { html } from "./html";
import { ADMIN_NAV_TABS, adminPageResponse } from "./layout";
import { proposalRoutes } from "./proposals";
import { ruleRoutes } from "./rules";

export interface AdminGetContext {
	request: Request;
	url: URL;
	env: UiEnv;
	now: UnixMillis;
	user: AccessUser;
	devMode: boolean;
	csrfToken: string;
	params: Record<string, string>;
}

export interface AdminPostContext extends AdminGetContext {
	form: URLSearchParams;
}

export type AdminGetHandler = (
	ctx: AdminGetContext,
) => Response | Promise<Response>;

export type AdminPostHandler = (
	ctx: AdminPostContext,
) => Response | Promise<Response>;

export interface AdminRoute {
	pattern: string;
	get?: AdminGetHandler;
	post?: AdminPostHandler;
}

export interface AdminHandlerOptions {
	fetchJwks?: JwksFetcher;
	routes?: readonly AdminRoute[];
}

function renderOverviewPage(ctx: AdminGetContext): Response {
	const body = html`
		<div class="stack">
			<div>
				<h1>paab 管理画面</h1>
				<p class="muted">
					エージェント間の質問ルール、トークン、監査ログを管理します。
				</p>
			</div>
			<div class="grid">
				${ADMIN_NAV_TABS.map(
					(tab) => html`
						<section class="card">
							<h2><a href="${tab.href}">${tab.label}</a></h2>
							<p class="muted">${tab.description}</p>
						</section>
					`,
				)}
			</div>
		</div>
	`;
	return adminPageResponse({
		title: "概要",
		currentPath: ctx.url.pathname,
		user: ctx.user,
		devMode: ctx.devMode,
		body,
	});
}

function placeholderRoute(pattern: string, title: string): AdminRoute {
	return {
		pattern,
		get: (ctx) =>
			adminPageResponse(
				{
					title,
					currentPath: ctx.url.pathname,
					user: ctx.user,
					devMode: ctx.devMode,
					body: html`
						<section class="card">
							<h1>${title}</h1>
							<p>この画面はまだ実装されていません。</p>
							<p><a href="/admin">概要へ戻る</a></p>
						</section>
					`,
				},
				501,
			),
	};
}

const IMPLEMENTED_ROUTES: readonly AdminRoute[] = [
	{ pattern: "/admin", get: renderOverviewPage },
	...agentRoutes(),
	...ruleRoutes(),
	...auditRoutes(),
	...proposalRoutes(),
	...adminBotRoutes(),
];
const IMPLEMENTED_PATTERNS = new Set(
	IMPLEMENTED_ROUTES.map((route) => route.pattern),
);

export const DEFAULT_ADMIN_ROUTES: readonly AdminRoute[] = [
	...IMPLEMENTED_ROUTES,
	...ADMIN_NAV_TABS.filter((tab) => !IMPLEMENTED_PATTERNS.has(tab.href)).map(
		(tab) => placeholderRoute(tab.href, tab.label),
	),
];

function normalizeAdminPath(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

function matchRoute(
	pattern: string,
	pathname: string,
): Record<string, string> | null {
	const patternParts = pattern.split("/");
	const pathParts = pathname.split("/");
	if (patternParts.length !== pathParts.length) {
		return null;
	}
	const params: Record<string, string> = {};
	for (let i = 0; i < patternParts.length; i += 1) {
		const expected = patternParts[i] ?? "";
		const actual = pathParts[i] ?? "";
		if (expected.startsWith(":")) {
			if (actual.length === 0) {
				return null;
			}
			try {
				params[expected.slice(1)] = decodeURIComponent(actual);
			} catch {
				return null;
			}
			continue;
		}
		if (expected !== actual) {
			return null;
		}
	}
	return params;
}

function findMatchingRoute(
	routes: readonly AdminRoute[],
	pathname: string,
): { route: AdminRoute; params: Record<string, string> } | null {
	for (const route of routes) {
		const params = matchRoute(route.pattern, pathname);
		if (params !== null) {
			return { route, params };
		}
	}
	return null;
}

function plainErrorResponse(
	status: number,
	message: string,
	extraHeaders?: Record<string, string>,
): Response {
	const headers = new Headers({
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		...extraHeaders,
	});
	return new Response(message, { status, headers });
}

function withCookieHeader(response: Response, setCookie: string): Response {
	const headers = new Headers(response.headers);
	headers.append("Set-Cookie", setCookie);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * Handles `/admin` and `/admin/*` requests behind Cloudflare Access verification
 * and double-submit CSRF protection.
 */
export async function handleAdminRequest(
	request: Request,
	env: UiEnv,
	now: UnixMillis,
	options: AdminHandlerOptions = {},
): Promise<Response> {
	const access = await verifyAccessRequest(request, env, now, {
		fetchJwks: options.fetchJwks,
	});
	if (!access.ok) {
		return plainErrorResponse(access.status, access.message);
	}

	const method = request.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD" && method !== "POST") {
		return plainErrorResponse(405, "Method Not Allowed", {
			Allow: "GET, HEAD, POST",
		});
	}

	const url = new URL(request.url);
	const pathname = normalizeAdminPath(url.pathname);
	const routes = options.routes ?? DEFAULT_ADMIN_ROUTES;

	if (method === "GET" || method === "HEAD") {
		const { token, setCookie } = prepareCsrfGet(request, url);
		const matched = findMatchingRoute(routes, pathname);
		const response =
			matched !== null && matched.route.get !== undefined
				? await matched.route.get({
						request,
						url,
						env,
						now,
						user: access.user,
						devMode: access.devMode,
						csrfToken: token,
						params: matched.params,
					})
				: matched !== null
					? plainErrorResponse(405, "Method Not Allowed", { Allow: "POST" })
					: adminPageResponse(
							{
								title: "見つかりません",
								currentPath: pathname,
								user: access.user,
								devMode: access.devMode,
								body: html`
									<section class="card">
										<h1>ページが見つかりません</h1>
										<p><a href="/admin">概要へ戻る</a></p>
									</section>
								`,
							},
							404,
						);

		const finalized =
			setCookie !== null ? withCookieHeader(response, setCookie) : response;
		if (method === "HEAD") {
			return new Response(null, {
				status: finalized.status,
				statusText: finalized.statusText,
				headers: finalized.headers,
			});
		}
		return finalized;
	}

	const csrf = await verifyCsrfPost(request, url);
	if (!csrf.ok) {
		return plainErrorResponse(csrf.status, csrf.message);
	}

	const matched = findMatchingRoute(routes, pathname);
	if (matched === null) {
		return adminPageResponse(
			{
				title: "見つかりません",
				currentPath: pathname,
				user: access.user,
				devMode: access.devMode,
				body: html`
					<section class="card">
						<h1>ページが見つかりません</h1>
						<p><a href="/admin">概要へ戻る</a></p>
					</section>
				`,
			},
			404,
		);
	}
	if (matched.route.post === undefined) {
		return plainErrorResponse(405, "Method Not Allowed", {
			Allow: "GET, HEAD",
		});
	}

	return matched.route.post({
		request,
		url,
		env,
		now,
		user: access.user,
		devMode: access.devMode,
		csrfToken: csrf.token,
		params: matched.params,
		form: csrf.form,
	});
}
