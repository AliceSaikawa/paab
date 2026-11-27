import type { PendingDescriptionView } from "../../adminbot";
import type { AgentStatus } from "../../types";
import { csrfInput } from "../csrf";
import { html, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";

export interface DescriptionsPageData {
	csrfToken: string;
	pending: readonly PendingDescriptionView[];
	adminBotAgentId: string | null;
}

function renderStatusBadge(status: AgentStatus): SafeHtml {
	return status === "active"
		? html`<span class="badge badge-ok">有効</span>`
		: html`<span class="badge badge-danger">停止中</span>`;
}

function renderPendingDescriptionCard(
	item: PendingDescriptionView,
	csrfToken: string,
): SafeHtml {
	const encodedId = encodeURIComponent(item.agentId);

	return html`
		<article class="card stack">
			<div class="actions">
				<strong>${item.agentName}</strong>
				${renderStatusBadge(item.agentStatus)}
				${
					item.isAdminBot
						? html`<span class="badge badge-dev">管理者ボット自身・画面承認のみ</span>`
						: false
				}
				<span class="muted">提出日時: ${formatTimestamp(item.submittedAt)}</span>
			</div>

			<div class="grid">
				<div class="card" style="background: var(--bg);">
					<div class="muted"><strong>現在公開中の説明文</strong></div>
					${
						item.currentDescription.length === 0
							? html`<p class="muted" style="margin: 0.35rem 0 0;">（未設定）</p>`
							: html`<p style="margin: 0.35rem 0 0; white-space: pre-wrap;">${item.currentDescription}</p>`
					}
				</div>
				<div class="card" style="background: var(--warn-bg); border-color: var(--warn-border);">
					<div class="muted"><strong>提出された説明文（エージェントが書いた外部データ）</strong></div>
					${
						item.pendingDescription.length === 0
							? html`<p class="muted" style="margin: 0.35rem 0 0;">（空の説明文・説明文を削除）</p>`
							: html`<p style="margin: 0.35rem 0 0; white-space: pre-wrap;">${item.pendingDescription}</p>`
					}
				</div>
			</div>

			<div class="actions">
				<form
					class="inline-form"
					method="POST"
					action="/admin/descriptions/${encodedId}/approve"
				>
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">承認して公開する</button>
				</form>
				<form
					class="inline-form"
					method="POST"
					action="/admin/descriptions/${encodedId}/reject"
				>
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-danger">却下する</button>
				</form>
			</div>
		</article>
	`;
}

/** Renders the `/admin/descriptions` review and approval screen (design 5.4). */
export function renderDescriptionsPage(data: DescriptionsPageData): SafeHtml {
	const adminBotNotice =
		data.adminBotAgentId === null
			? html`
				<div class="banner banner-info" role="note">
					現在管理者ボットは未指名のため、すべての説明文をこの画面で承認・却下します。
				</div>
			`
			: html`
				<div class="banner banner-info" role="note">
					他エージェントの説明文は管理者ボットからも承認・却下できます。管理者ボット自身の説明文は自己承認できないため、この画面から所有者が処理してください。
				</div>
			`;

	return html`
		<div class="stack">
			<div>
				<h1>説明文</h1>
				<p class="muted">
					エージェントから提出された説明文を確認し、公開を承認または却下します。承認されるまで <code>list_agents</code> には現在公開中の説明文が表示され続けます。
				</p>
			</div>

			${adminBotNotice}

			<section class="card stack">
				<div>
					<h2>承認待ちの説明文（${data.pending.length} 件）</h2>
					<p class="muted">
						提出された説明文はエージェントが作成した外部データです。内容を確認してから承認してください。
					</p>
				</div>
				${
					data.pending.length === 0
						? html`<p class="muted">承認待ちの説明文はありません。</p>`
						: data.pending.map((item) =>
								renderPendingDescriptionCard(item, data.csrfToken),
							)
				}
			</section>
		</div>
	`;
}
