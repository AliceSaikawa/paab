import type { UnixMillis } from "../types";
import type { AccessUser } from "./access";
import { html, rawHtml, type SafeHtml } from "./html";

export interface AdminNavTab {
	href: string;
	label: string;
	description: string;
}

export const ADMIN_NAV_TABS: readonly AdminNavTab[] = [
	{
		href: "/admin/agents",
		label: "エージェント",
		description:
			"エージェントの登録・削除、停止・再開、トークンの発行と再発行。",
	},
	{
		href: "/admin/rules",
		label: "ルール・カテゴリ",
		description: "許可ルールと質問カテゴリの追加・削除。",
	},
	{
		href: "/admin/audit",
		label: "監査ログ",
		description: "質問や認証の履歴を期間・相手・結果で絞り込んで確認。",
	},
	{
		href: "/admin/proposals",
		label: "提案",
		description: "管理者ボットから提出された設定変更の提案を承認・却下。",
	},
	{
		href: "/admin/descriptions",
		label: "説明文",
		description: "エージェントから提出された説明文の審査・承認。",
	},
	{
		href: "/admin/adminbot",
		label: "管理者ボット",
		description: "管理者ボットの指名と本文閲覧・最高管理者権限の設定。",
	},
] as const;

export interface FlashMessage {
	kind: "info" | "success" | "warning" | "error";
	message: string | SafeHtml;
}

export interface AdminLayoutOptions {
	title: string;
	currentPath: string;
	user: AccessUser;
	devMode: boolean;
	body: SafeHtml;
	flash?: FlashMessage;
}

const TIME_FORMAT_SCRIPT = [
	'for(const e of document.querySelectorAll("time[datetime]")){',
	'const v=e.getAttribute("datetime");if(!v)continue;',
	"const d=new Date(v);if(Number.isNaN(d.getTime()))continue;",
	'e.textContent=d.toLocaleString("ja-JP",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});',
	"e.title=v;",
	"}",
].join("");

// Precomputed SHA-256 base64 of TIME_FORMAT_SCRIPT so inline script runs without `'unsafe-inline'`.
const TIME_FORMAT_SCRIPT_HASH =
	"sha256-dl8hcGSQuDL/LIYO8fg5voOxjHlb3au206vbBxpb5pw=";

const ADMIN_CSS = `
:root {
	--bg: #f8fafc;
	--surface: #ffffff;
	--border: #e2e8f0;
	--text: #0f172a;
	--muted: #475569;
	--accent: #2563eb;
	--accent-hover: #1d4ed8;
	--danger: #dc2626;
	--danger-hover: #b91c1c;
	--success-bg: #f0fdf4;
	--success-border: #86efac;
	--success-text: #166534;
	--info-bg: #eff6ff;
	--info-border: #93c5fd;
	--info-text: #1e40af;
	--warn-bg: #fffbeb;
	--warn-border: #fcd34d;
	--warn-text: #92400e;
	--error-bg: #fef2f2;
	--error-border: #fca5a5;
	--error-text: #991b1b;
}
* { box-sizing: border-box; }
body {
	margin: 0;
	font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", "Hiragino Sans", sans-serif;
	background: var(--bg);
	color: var(--text);
	line-height: 1.6;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.topbar {
	background: var(--surface);
	border-bottom: 1px solid var(--border);
}
.topbar-inner, .nav-inner, .main {
	max-width: 1040px;
	margin: 0 auto;
	padding-left: 1rem;
	padding-right: 1rem;
}
.topbar-inner {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 0.75rem;
	padding-top: 0.85rem;
	padding-bottom: 0.85rem;
}
.brand {
	font-size: 1.125rem;
	font-weight: 700;
	color: var(--text);
}
.user-meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
	font-size: 0.875rem;
	color: var(--muted);
}
.badge {
	display: inline-block;
	padding: 0.15rem 0.55rem;
	border-radius: 999px;
	font-size: 0.75rem;
	font-weight: 600;
	background: #e2e8f0;
	color: var(--text);
}
.badge-dev {
	background: var(--warn-bg);
	color: var(--warn-text);
	border: 1px solid var(--warn-border);
}
.badge-ok {
	background: var(--success-bg);
	color: var(--success-text);
	border: 1px solid var(--success-border);
}
.badge-danger {
	background: var(--error-bg);
	color: var(--error-text);
	border: 1px solid var(--error-border);
}
.nav {
	background: var(--surface);
	border-bottom: 1px solid var(--border);
}
.nav-inner {
	display: flex;
	flex-wrap: wrap;
	gap: 0.25rem;
}
.nav-tab {
	display: inline-block;
	padding: 0.65rem 0.9rem;
	font-size: 0.9rem;
	font-weight: 500;
	color: var(--muted);
	border-bottom: 2px solid transparent;
}
.nav-tab:hover {
	color: var(--text);
	text-decoration: none;
}
.nav-tab[aria-current="page"] {
	color: var(--accent);
	border-bottom-color: var(--accent);
	font-weight: 600;
}
.main {
	padding-top: 1.5rem;
	padding-bottom: 3rem;
}
h1, h2, h3 { margin-top: 0; line-height: 1.3; }
h1 { font-size: 1.4rem; margin-bottom: 1rem; }
h2 { font-size: 1.125rem; margin-bottom: 0.75rem; }
.stack { display: grid; gap: 1rem; }
.grid {
	display: grid;
	gap: 1rem;
	grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}
.card {
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 1rem 1.25rem;
}
.banner {
	padding: 0.75rem 1rem;
	border-radius: 6px;
	border: 1px solid var(--border);
	margin-bottom: 1rem;
	font-size: 0.925rem;
}
.banner-info { background: var(--info-bg); border-color: var(--info-border); color: var(--info-text); }
.banner-success { background: var(--success-bg); border-color: var(--success-border); color: var(--success-text); }
.banner-warning { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.banner-error { background: var(--error-bg); border-color: var(--error-border); color: var(--error-text); }
.table-wrap { overflow-x: auto; }
table {
	width: 100%;
	border-collapse: collapse;
	font-size: 0.9rem;
}
th, td {
	text-align: left;
	padding: 0.55rem 0.7rem;
	border-bottom: 1px solid var(--border);
	vertical-align: top;
}
th {
	font-weight: 600;
	color: var(--muted);
	white-space: nowrap;
}
.field {
	display: grid;
	gap: 0.3rem;
	margin-bottom: 0.85rem;
}
label { font-size: 0.875rem; font-weight: 600; }
input[type="text"], input[type="number"], input[type="url"], input[type="password"], select, textarea {
	width: 100%;
	padding: 0.5rem 0.65rem;
	border: 1px solid #cbd5e1;
	border-radius: 6px;
	font: inherit;
	background: #fff;
	color: var(--text);
}
textarea { min-height: 5rem; }
.btn {
	display: inline-block;
	padding: 0.45rem 0.9rem;
	border-radius: 6px;
	border: 1px solid #cbd5e1;
	background: var(--surface);
	color: var(--text);
	font: inherit;
	font-size: 0.875rem;
	font-weight: 600;
	cursor: pointer;
}
.btn-primary {
	background: var(--accent);
	border-color: var(--accent);
	color: #fff;
}
.btn-primary:hover { background: var(--accent-hover); }
.btn-danger {
	background: var(--danger);
	border-color: var(--danger);
	color: #fff;
}
.btn-danger:hover { background: var(--danger-hover); }
.inline-form { display: inline-block; margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.token-box {
	padding: 0.75rem;
	background: #0f172a;
	color: #f8fafc;
	border-radius: 6px;
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	font-size: 0.875rem;
	overflow-x: auto;
	word-break: break-all;
}
.muted { color: var(--muted); font-size: 0.875rem; }
`;

export function adminContentSecurityPolicy(): string {
	return [
		"default-src 'none'",
		"base-uri 'none'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"form-action 'self'",
		"img-src 'self'",
		"style-src 'unsafe-inline'",
		`script-src '${TIME_FORMAT_SCRIPT_HASH}'`,
	].join("; ");
}

/** Security headers applied to all Admin UI HTML responses. */
export function adminSecurityHeaders(): Headers {
	return new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		// `same-origin` avoids sending `Referer` externally while keeping same-origin `Origin` intact on POSTs.
		"Referrer-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Content-Security-Policy": adminContentSecurityPolicy(),
	});
}

function isTabActive(currentPath: string, href: string): boolean {
	return currentPath === href || currentPath.startsWith(`${href}/`);
}

function renderBanner(flash: FlashMessage): SafeHtml {
	const role = flash.kind === "error" ? "alert" : "status";
	return html`<div class="banner banner-${flash.kind}" role="${role}">${flash.message}</div>`;
}

/** Renders a `<time>` element in UTC ISO format that upgrades client-side to local time. */
export function formatTimestamp(ms: UnixMillis): SafeHtml {
	const iso = new Date(ms).toISOString();
	return html`<time datetime="${iso}">${iso}</time>`;
}

/** Renders the full Admin UI HTML5 document. */
export function renderAdminLayout(options: AdminLayoutOptions): SafeHtml {
	const devBanner = options.devMode
		? renderBanner({
				kind: "warning",
				message:
					"開発モード（ADMIN_DEV_USER）で表示しています。本番環境では CF_ACCESS_TEAM_DOMAIN と CF_ACCESS_AUD を設定してください。",
			})
		: false;

	const flashBanner =
		options.flash !== undefined ? renderBanner(options.flash) : false;

	return html`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title} - paab 管理</title>
<style>${rawHtml(ADMIN_CSS)}</style>
</head>
<body>
<header class="topbar">
	<div class="topbar-inner">
		<a class="brand" href="/admin">paab 管理</a>
		<div class="user-meta">
			${options.devMode ? html`<span class="badge badge-dev">開発モード</span>` : false}
			<span class="badge">${options.user.email}</span>
		</div>
	</div>
</header>
<nav class="nav" aria-label="管理メニュー">
	<div class="nav-inner">
		${ADMIN_NAV_TABS.map((tab) => {
			const active = isTabActive(options.currentPath, tab.href);
			return html`<a class="nav-tab" href="${tab.href}"${active ? rawHtml(' aria-current="page"') : false}>${tab.label}</a>`;
		})}
	</div>
</nav>
<main class="main">
	${devBanner}
	${flashBanner}
	${options.body}
</main>
<script>${rawHtml(TIME_FORMAT_SCRIPT)}</script>
</body>
</html>`;
}

/** Builds an HTML `Response` with Admin UI security headers. */
export function adminHtmlResponse(
	documentHtml: SafeHtml,
	status = 200,
): Response {
	return new Response(documentHtml.html, {
		status,
		headers: adminSecurityHeaders(),
	});
}

/** Renders the Admin UI layout and returns an HTTP `Response` with security headers. */
export function adminPageResponse(
	options: AdminLayoutOptions,
	status = 200,
): Response {
	return adminHtmlResponse(renderAdminLayout(options), status);
}
