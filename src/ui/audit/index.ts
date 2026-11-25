import { isBodyRecordingEnabled } from "../../audit";
import { auditBodyConfig } from "../../mcp/config";
import { adminPageResponse } from "../layout";
import type { AdminGetContext, AdminRoute } from "../router";
import { parseAuditSearchParams } from "./filter";
import { fetchAuditPage, renderAuditPage } from "./page";

async function handleAuditGet(ctx: AdminGetContext): Promise<Response> {
	const bodyRecordingEnabled = isBodyRecordingEnabled(auditBodyConfig(ctx.env));
	const parsed = parseAuditSearchParams(ctx.url.searchParams);

	if (!parsed.ok) {
		return adminPageResponse(
			{
				title: "監査ログ",
				currentPath: ctx.url.pathname,
				user: ctx.user,
				devMode: ctx.devMode,
				flash: { kind: "error", message: parsed.error },
				body: renderAuditPage({
					raw: parsed.raw,
					bodyRecordingEnabled,
				}),
			},
			400,
		);
	}

	const page = await fetchAuditPage(
		ctx.env.DB,
		parsed.query,
		bodyRecordingEnabled,
	);

	return adminPageResponse({
		title: "監査ログ",
		currentPath: ctx.url.pathname,
		user: ctx.user,
		devMode: ctx.devMode,
		body: renderAuditPage({
			raw: parsed.query.raw,
			query: parsed.query,
			page,
			bodyRecordingEnabled,
		}),
	});
}

/** Admin UI routes for browsing and tracing the audit log. */
export function auditRoutes(): AdminRoute[] {
	return [{ pattern: "/admin/audit", get: handleAuditGet }];
}

export {
	type AuditCursor,
	type AuditHrefOptions,
	type AuditQueryParseResult,
	buildAuditHref,
	DEFAULT_UI_AUDIT_LIMIT,
	MAX_UI_AUDIT_LIMIT,
	type ParsedAuditQuery,
	parseAuditSearchParams,
	parseAuditTime,
	type RawAuditFormValues,
} from "./filter";
export { type AuditPageData, fetchAuditPage } from "./page";
