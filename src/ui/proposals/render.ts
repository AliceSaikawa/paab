import type { AgentWithStatus, CategoryWithUsage } from "../../admin";
import {
	describeProposalEffect,
	MAX_PENDING_PROPOSALS,
	type ProposalEffectNames,
} from "../../adminbot";
import type {
	ChangeLogEntry,
	Proposal,
	ProposalKind,
	ProposalStatus,
} from "../../types";
import { csrfInput } from "../csrf";
import { html, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";
import { collectEntityNames } from "../rules/render";

export const PROPOSAL_KIND_LABELS: Record<ProposalKind, string> = {
	grant_allow_rule: "許可ルール追加",
	create_category: "カテゴリ追加",
	raise_daily_limit: "質問数上限引き上げ",
	resume_agent: "エージェント再開",
};

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
	pending: "承認待ち",
	approved: "承認済み",
	rejected: "却下済み",
	expired: "期限切れ",
};

export interface ProposalsPageData {
	csrfToken: string;
	pending: readonly Proposal[];
	history: readonly Proposal[];
	agents: readonly AgentWithStatus[];
	categories: readonly CategoryWithUsage[];
	changeLog: readonly ChangeLogEntry[];
}

function renderProposalStatusBadge(status: ProposalStatus): SafeHtml {
	switch (status) {
		case "pending":
			return html`<span class="badge badge-dev">${PROPOSAL_STATUS_LABELS.pending}</span>`;
		case "approved":
			return html`<span class="badge badge-ok">${PROPOSAL_STATUS_LABELS.approved}</span>`;
		case "rejected":
			return html`<span class="badge badge-danger">${PROPOSAL_STATUS_LABELS.rejected}</span>`;
		case "expired":
			return html`<span class="badge">${PROPOSAL_STATUS_LABELS.expired}</span>`;
	}
}

function renderProposalBlocks(
	proposal: Proposal,
	effectNames: ProposalEffectNames,
): SafeHtml {
	// Mechanical summary is generated solely from `proposal.payload` and DB names —
	// never from `proposal.reason` (design 5.3).
	const effect = describeProposalEffect(proposal.payload, effectNames);
	return html`
		<div class="banner banner-info" style="margin-bottom: 0;">
			<div><strong>承認すると変わること（ブリッジが自動生成）</strong></div>
			<div>${effect}</div>
		</div>
		<div class="card" style="background: var(--bg);">
			<div class="muted"><strong>管理者ボットが書いた理由（参考情報）</strong></div>
			<p style="margin: 0.35rem 0 0; white-space: pre-wrap;">${proposal.reason}</p>
		</div>
	`;
}

function renderPendingProposalCard(
	proposal: Proposal,
	names: ProposalEffectNames,
	csrfToken: string,
): SafeHtml {
	const proposerName =
		names.agents.get(proposal.proposerAgentId) ?? proposal.proposerAgentId;
	const encodedId = encodeURIComponent(proposal.id);

	return html`
		<article class="card stack">
			<div class="actions">
				<span class="badge">${PROPOSAL_KIND_LABELS[proposal.kind]}</span>
				${renderProposalStatusBadge(proposal.status)}
				<span class="muted">
					提案元: <strong>${proposerName}</strong> /
					作成: ${formatTimestamp(proposal.createdAt)} /
					有効期限: ${formatTimestamp(proposal.expiresAt)}
				</span>
			</div>
			${renderProposalBlocks(proposal, names)}
			<div class="actions">
				<form
					class="inline-form"
					method="POST"
					action="/admin/proposals/${encodedId}/approve"
				>
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">承認して反映する</button>
				</form>
				<form
					class="inline-form"
					method="POST"
					action="/admin/proposals/${encodedId}/reject"
				>
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-danger">却下する</button>
				</form>
			</div>
		</article>
	`;
}

function renderHistoryProposalCard(
	proposal: Proposal,
	names: ProposalEffectNames,
): SafeHtml {
	const proposerName =
		names.agents.get(proposal.proposerAgentId) ?? proposal.proposerAgentId;

	return html`
		<article class="card stack">
			<div class="actions">
				<span class="badge">${PROPOSAL_KIND_LABELS[proposal.kind]}</span>
				${renderProposalStatusBadge(proposal.status)}
				<span class="muted">
					提案元: <strong>${proposerName}</strong> /
					作成: ${formatTimestamp(proposal.createdAt)} /
					有効期限: ${formatTimestamp(proposal.expiresAt)}
					${proposal.resolvedAt !== null ? html` / 処理日時: ${formatTimestamp(proposal.resolvedAt)}` : false}
					${proposal.resolvedBy !== null ? html` / 処理者: ${proposal.resolvedBy}` : false}
					${proposal.changeLogId !== null ? html` / 変更履歴: #${proposal.changeLogId}` : false}
				</span>
			</div>
			${renderProposalBlocks(proposal, names)}
		</article>
	`;
}

/** Renders the `/admin/proposals` approval/rejection screen (design 5.3). */
export function renderProposalsPage(data: ProposalsPageData): SafeHtml {
	const entityNames = collectEntityNames(
		data.agents,
		data.categories,
		data.changeLog,
	);
	const agentLimits = new Map<string, number>();
	for (const item of data.agents) {
		agentLimits.set(item.agent.id, item.agent.dailyQuestionLimit);
	}

	const pendingNames: ProposalEffectNames = {
		agents: entityNames.agents,
		categories: entityNames.categories,
		agentLimits,
	};
	const historyNames: ProposalEffectNames = {
		agents: entityNames.agents,
		categories: entityNames.categories,
	};

	return html`
		<div class="stack">
			<div>
				<h1>提案</h1>
				<p class="muted">
					管理者ボットから提出された設定変更の提案を確認し、承認または却下します。未処理の提案は 14 日で自動的に期限切れになり、管理者ボットの指名解除・変更時にも保留中の提案は自動で却下されます。
				</p>
			</div>

			<section class="card stack">
				<div>
					<h2>承認待ちの提案（${data.pending.length} / ${MAX_PENDING_PROPOSALS} 件）</h2>
					<p class="muted">
						承認ボタンを押すまで実際のルール・カテゴリ・エージェント設定は変更されません。
					</p>
				</div>
				${
					data.pending.length === 0
						? html`<p class="muted">承認待ちの提案はありません。</p>`
						: data.pending.map((proposal) =>
								renderPendingProposalCard(
									proposal,
									pendingNames,
									data.csrfToken,
								),
							)
				}
			</section>

			<section class="card stack">
				<div>
					<h2>処理済み・期限切れの提案</h2>
					<p class="muted">
						承認・却下・期限切れになった提案の履歴を新しい順に表示します。
					</p>
				</div>
				${
					data.history.length === 0
						? html`<p class="muted">処理済み・期限切れの提案はまだありません。</p>`
						: data.history.map((proposal) =>
								renderHistoryProposalCard(proposal, historyNames),
							)
				}
			</section>
		</div>
	`;
}
