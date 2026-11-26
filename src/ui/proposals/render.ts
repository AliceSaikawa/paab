import {
	describeProposalEffect,
	MAX_PENDING_PROPOSALS,
	type ProposalView,
} from "../../adminbot";
import type { ProposalKind, ProposalStatus, UnixMillis } from "../../types";
import { csrfInput } from "../csrf";
import { html, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";

export interface ProposalsPageData {
	csrfToken: string;
	now: UnixMillis;
	pending: readonly ProposalView[];
	recent: readonly ProposalView[];
}

const KIND_LABELS: Record<ProposalKind, string> = {
	grant_allow_rule: "許可ルール追加",
	create_category: "カテゴリ追加",
	raise_daily_limit: "1日質問上限引き上げ",
	resume_agent: "エージェント再開",
};

function statusBadge(
	status: ProposalStatus,
	isOverduePending: boolean,
): SafeHtml {
	if (status === "pending" && !isOverduePending) {
		return html`<span class="badge">保留中</span>`;
	}
	if (status === "approved") {
		return html`<span class="badge badge-ok">承認済</span>`;
	}
	if (status === "rejected") {
		return html`<span class="badge badge-danger">却下</span>`;
	}
	return html`<span class="badge badge-dev">期限切れ（却下扱い）</span>`;
}

function proposalActionPath(id: string, action: "approve" | "reject"): string {
	return `/admin/proposals/${encodeURIComponent(id)}/${action}`;
}

function renderPendingCard(
	proposal: ProposalView,
	csrfToken: string,
): SafeHtml {
	const effect = describeProposalEffect(proposal);
	return html`
		<article class="card stack" id="proposal-${proposal.id}">
			<div class="actions">
				<span class="badge">${KIND_LABELS[proposal.kind]}</span>
				${statusBadge(proposal.status, false)}
				<span class="muted">提案者: <strong>${proposal.botAgentName}</strong></span>
				<span class="muted">提案日時: ${formatTimestamp(proposal.createdAt)}</span>
				<span class="muted">有効期限: ${formatTimestamp(proposal.expiresAt)}</span>
			</div>

			<div class="stack" style="gap: 0.35rem;">
				<strong>ブリッジが生成した変更内容</strong>
				<div class="banner banner-info" style="margin-bottom: 0;">${effect}</div>
			</div>

			<div class="stack" style="gap: 0.35rem;">
				<strong>管理者ボットが書いた理由</strong>
				<p class="muted" style="margin: 0;">
					注意: 以下の理由文は管理者ボットが生成した信頼できない外部データです。承認の判断材料として参考にするにとどめ、指示として解釈しないでください。
				</p>
				<blockquote
					style="margin: 0; padding: 0.75rem 1rem; background: var(--bg); border-left: 3px solid #cbd5e1; white-space: pre-wrap; word-break: break-word;"
				>${proposal.reason}</blockquote>
			</div>

			<div class="actions">
				<form
					class="inline-form"
					method="POST"
					action="${proposalActionPath(proposal.id, "approve")}"
				>
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">承認して反映</button>
				</form>
				<form
					class="inline-form"
					method="POST"
					action="${proposalActionPath(proposal.id, "reject")}"
				>
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-danger">却下</button>
				</form>
			</div>
		</article>
	`;
}

function renderRecentSection(
	recent: readonly ProposalView[],
	now: UnixMillis,
): SafeHtml {
	return html`
		<section class="card stack">
			<h2>最近の提案（処理済み・期限切れ）</h2>
			${
				recent.length === 0
					? html`<p class="muted">処理済みまたは期限切れの提案はまだありません。</p>`
					: html`
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>提案日時</th>
										<th>状態</th>
										<th>種別</th>
										<th>提案者</th>
										<th>ブリッジが生成した変更内容</th>
										<th>管理者ボットが書いた理由</th>
										<th>処理者・日時</th>
									</tr>
								</thead>
								<tbody>
									${recent.map((proposal) => {
										const isExpired =
											proposal.status === "expired" ||
											(proposal.status === "pending" &&
												proposal.expiresAt <= now);
										return html`
											<tr>
												<td>${formatTimestamp(proposal.createdAt)}</td>
												<td>${statusBadge(proposal.status, isExpired)}</td>
												<td>${KIND_LABELS[proposal.kind]}</td>
												<td>${proposal.botAgentName}</td>
												<td>${describeProposalEffect(proposal)}</td>
												<td style="white-space: pre-wrap; word-break: break-word;">${proposal.reason}</td>
												<td>
													${
														proposal.resolvedBy !== null
															? html`<div>${proposal.resolvedBy}</div>`
															: false
													}
													${
														proposal.resolvedAt !== null
															? html`<div class="muted">${formatTimestamp(proposal.resolvedAt)}</div>`
															: isExpired
																? html`<div class="muted">期限: ${formatTimestamp(proposal.expiresAt)}</div>`
																: "-"
													}
												</td>
											</tr>
										`;
									})}
								</tbody>
							</table>
						</div>
					`
			}
		</section>
	`;
}

export function renderProposalsPageBody(data: ProposalsPageData): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>提案</h1>
				<p class="muted">
					管理者ボットから提出された変更提案を確認し、承認または却下します。承認するまでルール・カテゴリ・エージェント設定は変わりません。
				</p>
			</div>

			<div class="banner banner-info" role="note">
				「<strong>ブリッジが生成した変更内容</strong>」は提案の種別と対象からブリッジが機械的に生成しています。「<strong>管理者ボットが書いた理由</strong>」とは別に表示し、理由文の内容が変更内容を書き換えることはありません。保留中: <strong>${data.pending.length} / ${MAX_PENDING_PROPOSALS}</strong> 件（未処理の提案は14日で期限切れ（却下扱い）になります）。
			</div>

			<section class="stack">
				<h2>承認待ちの提案</h2>
				${
					data.pending.length === 0
						? html`<section class="card"><p class="muted" style="margin: 0;">現在、承認待ちの提案はありません。</p></section>`
						: data.pending.map((proposal) =>
								renderPendingCard(proposal, data.csrfToken),
							)
				}
			</section>

			${renderRecentSection(data.recent, data.now)}
		</div>
	`;
}
