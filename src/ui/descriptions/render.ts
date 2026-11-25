import type { PendingDescriptionItem } from "../../adminbot/descriptions";
import { csrfInput } from "../csrf";
import { html, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";

export interface DescriptionsPageView {
	items: readonly PendingDescriptionItem[];
	adminBotAgentId: string | null;
	csrfToken: string;
}

function descriptionActionPath(
	agentId: string,
	action: "approve" | "reject",
): string {
	return `/admin/descriptions/${encodeURIComponent(agentId)}/${action}`;
}

function renderStatusBadge(
	status: PendingDescriptionItem["agentStatus"],
): SafeHtml {
	return status === "active"
		? html`<span class="badge badge-ok">有効</span>`
		: html`<span class="badge badge-danger">停止中</span>`;
}

function renderDescriptionText(
	text: string,
	emptyLabel: string,
	muted: boolean,
): SafeHtml {
	if (text.length === 0) {
		return html`<p class="muted" style="margin: 0;">${emptyLabel}</p>`;
	}
	return muted
		? html`<p class="muted" style="margin: 0; white-space: pre-wrap;">${text}</p>`
		: html`<p style="margin: 0; white-space: pre-wrap;">${text}</p>`;
}

function renderPendingCard(
	item: PendingDescriptionItem,
	isAdminBot: boolean,
	csrfToken: string,
): SafeHtml {
	return html`
		<section class="card stack" id="pending-description-${item.agentId}">
			<div class="actions">
				<h2 style="margin: 0;">${item.agentName}</h2>
				${renderStatusBadge(item.agentStatus)}
				${isAdminBot ? html`<span class="badge badge-dev">管理者ボット</span>` : false}
				<span class="muted">提出日時: ${formatTimestamp(item.submittedAt)}</span>
			</div>

			${
				isAdminBot
					? html`
						<div class="banner banner-warning" role="note">
							このエージェントは現在の管理者ボットです。管理者ボット自身の説明文は自己承認できないため、画面から利用者が承認または却下してください。
						</div>
					`
					: false
			}

			<div class="stack">
				<div>
					<strong>現在の公開中の説明文</strong>
					${renderDescriptionText(item.currentDescription, "（未設定）", true)}
				</div>
				<div>
					<strong>提出された説明文（承認待ち）</strong>
					${renderDescriptionText(
						item.pendingDescription,
						"（空の説明文：承認すると現在の説明文が消去されます）",
						false,
					)}
				</div>
			</div>

			<div class="actions">
				<form class="inline-form" method="POST" action="${descriptionActionPath(item.agentId, "approve")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">承認する</button>
				</form>
				<form class="inline-form" method="POST" action="${descriptionActionPath(item.agentId, "reject")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-danger">却下する</button>
				</form>
			</div>
		</section>
	`;
}

/** Renders the `/admin/descriptions` pending description review screen. */
export function renderDescriptionsPageBody(
	view: DescriptionsPageView,
): SafeHtml {
	const noAdminBotNotice =
		view.adminBotAgentId === null
			? html`
				<div class="banner banner-info" role="note">
					現在、管理者ボットは指名されていないため、すべての説明文の承認・却下をこの画面で行います。
				</div>
			`
			: false;

	const content =
		view.items.length === 0
			? html`
				<section class="card">
					<p class="muted" style="margin: 0;">承認待ちの説明文はありません。</p>
				</section>
			`
			: view.items.map((item) =>
					renderPendingCard(
						item,
						view.adminBotAgentId === item.agentId,
						view.csrfToken,
					),
				);

	return html`
		<div class="stack">
			<div>
				<h1>説明文の承認（${view.items.length}件）</h1>
				<p class="muted">
					エージェントから提出された説明文の案を確認して承認または却下します。承認されるまで <code>list_agents</code> には以前の説明文が表示されます。
				</p>
			</div>
			${noAdminBotNotice}
			${content}
		</div>
	`;
}
