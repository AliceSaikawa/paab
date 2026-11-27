import type { AgentWithStatus } from "../../admin";
import { csrfInput } from "../csrf";
import { html, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";

export interface RegisterFormDraft {
	name: string;
	description: string;
	dailyQuestionLimit: string;
	ownerId: string;
}

export interface IssuedTokenView {
	agentName: string;
	token: string;
	revokedPrevious: boolean;
	mcpUrl: string;
}

function agentActionPath(agentId: string, suffix = ""): string {
	return `/admin/agents/${encodeURIComponent(agentId)}${suffix}`;
}

function renderStatusBadge(
	status: AgentWithStatus["agent"]["status"],
): SafeHtml {
	return status === "active"
		? html`<span class="badge badge-ok">有効</span>`
		: html`<span class="badge badge-danger">停止中</span>`;
}

function renderParticipantTokenSection(
	entry: AgentWithStatus,
	csrfToken: string,
): SafeHtml {
	const { agent, activeTokens } = entry;
	const token = activeTokens.participant;

	if (token === null) {
		return html`
			<div class="stack">
				<div>
					<strong>参加者トークン:</strong>
					<span class="badge">未発行</span>
				</div>
				<form method="POST" action="${agentActionPath(agent.id, "/token")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">参加者トークンを発行</button>
				</form>
			</div>
		`;
	}

	return html`
		<div class="stack">
			<div>
				<strong>参加者トークン:</strong>
				<span class="badge badge-ok">有効</span>
				<span class="muted">（発行日時: ${formatTimestamp(token.createdAt)}）</span>
			</div>
			<div class="banner banner-warning" role="note">
				注意: 参加者トークンを再発行すると、現在有効なトークンは即座に無効になります。
			</div>
			<div class="actions">
				<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/token")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">参加者トークンを再発行</button>
				</form>
				<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/token/revoke")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-danger">参加者トークンを失効</button>
				</form>
			</div>
		</div>
	`;
}

function renderAgentCard(entry: AgentWithStatus, csrfToken: string): SafeHtml {
	const { agent, todayQuestionCount } = entry;
	const descInputId = `agent-description-${agent.id}`;
	const limitInputId = `agent-limit-${agent.id}`;

	const statusForm =
		agent.status === "active"
			? html`
				<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/suspend")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn">停止する</button>
				</form>
			`
			: html`
				<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/resume")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">再開する</button>
				</form>
			`;

	return html`
		<section class="card stack" id="agent-${agent.id}">
			<div class="actions">
				<h2 style="margin: 0;">${agent.name}</h2>
				${renderStatusBadge(agent.status)}
				<span class="muted">所有者: ${agent.ownerId}</span>
				<span class="muted">登録日時: ${formatTimestamp(agent.createdAt)}</span>
			</div>

			<div class="muted">
				本日の質問数 (UTC): <strong>${todayQuestionCount}</strong> / 1日上限 <strong>${agent.dailyQuestionLimit}</strong>
			</div>

			<form method="POST" action="${agentActionPath(agent.id, "/update")}">
				${csrfInput(csrfToken)}
				<div class="field">
					<label for="${descInputId}">説明文</label>
					<textarea id="${descInputId}" name="description" maxlength="1000">${agent.description}</textarea>
				</div>
				<div class="field">
					<label for="${limitInputId}">1日あたりの質問数上限</label>
					<input
						id="${limitInputId}"
						type="number"
						name="daily_question_limit"
						min="0"
						step="1"
						required
						value="${agent.dailyQuestionLimit}"
					>
				</div>
				<div class="actions">
					<button type="submit" class="btn">設定を更新</button>
				</div>
			</form>

			${renderParticipantTokenSection(entry, csrfToken)}

			<div class="actions">
				${statusForm}
				<a class="btn btn-danger" href="${agentActionPath(agent.id, "/delete")}">削除…</a>
			</div>
		</section>
	`;
}

export function renderAgentsPageBody(options: {
	agents: readonly AgentWithStatus[];
	defaultOwnerId: string;
	csrfToken: string;
	registerDraft?: RegisterFormDraft;
}): SafeHtml {
	const draft = options.registerDraft ?? {
		name: "",
		description: "",
		dailyQuestionLimit: "20",
		ownerId: "",
	};

	const listSection =
		options.agents.length === 0
			? html`
				<section class="card">
					<p class="muted">登録されているエージェントはまだありません。下のフォームから登録してください。</p>
				</section>
			`
			: options.agents.map((entry) =>
					renderAgentCard(entry, options.csrfToken),
				);

	return html`
		<div class="stack">
			<div>
				<h1>エージェント管理（${options.agents.length}件）</h1>
				<p class="muted">
					エージェントの登録・編集・停止/再開・削除と、MCP 接続用の参加者トークン発行を行います。
				</p>
			</div>

			${listSection}

			<section class="card">
				<h2>新しいエージェントを登録</h2>
				<form method="POST" action="/admin/agents">
					${csrfInput(options.csrfToken)}
					<div class="field">
						<label for="register-name">エージェント名</label>
						<input
							id="register-name"
							type="text"
							name="name"
							maxlength="64"
							required
							value="${draft.name}"
						>
						<div class="muted">1〜64文字。改行・制御文字・カンマ（,）は使えません。</div>
					</div>
					<div class="field">
						<label for="register-description">説明文（任意）</label>
						<textarea
							id="register-description"
							name="description"
							maxlength="1000"
						>${draft.description}</textarea>
					</div>
					<div class="field">
						<label for="register-daily-limit">1日あたりの質問数上限</label>
						<input
							id="register-daily-limit"
							type="number"
							name="daily_question_limit"
							min="0"
							step="1"
							required
							value="${draft.dailyQuestionLimit}"
						>
					</div>
					<div class="field">
						<label for="register-owner-id">所有者 ID（任意）</label>
						<input
							id="register-owner-id"
							type="text"
							name="owner_id"
							maxlength="64"
							placeholder="${options.defaultOwnerId}"
							value="${draft.ownerId}"
						>
						<div class="muted">
							空欄の場合は既定の所有者 ID（<code>${options.defaultOwnerId}</code>）が使われます。
						</div>
					</div>
					<button type="submit" class="btn btn-primary">エージェントを登録</button>
				</form>
			</section>
		</div>
	`;
}

export function renderDeleteConfirmBody(options: {
	entry: AgentWithStatus;
	csrfToken: string;
}): SafeHtml {
	const { agent, activeTokens } = options.entry;

	return html`
		<div class="stack">
			<div>
				<h1>エージェントの削除確認</h1>
				<p class="muted">操作を取り消すことはできません。内容を確認してください。</p>
			</div>

			<div class="banner banner-warning" role="alert">
				エージェント「${agent.name}」を削除すると、紐づくトークン・許可ルール・メッセージも削除されます（監査ログと変更履歴の記録は保持されます）。
			</div>

			<section class="card stack">
				<div><strong>エージェント名:</strong> ${agent.name}</div>
				<div><strong>状態:</strong> ${renderStatusBadge(agent.status)}</div>
				<div><strong>説明文:</strong> ${agent.description || "（未設定）"}</div>
				<div><strong>1日あたりの質問数上限:</strong> ${agent.dailyQuestionLimit}</div>
				<div>
					<strong>参加者トークン:</strong>
					${activeTokens.participant === null ? "未発行" : "有効なトークンあり（同時に削除されます）"}
				</div>
				<div class="actions">
					<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/delete")}">
						${csrfInput(options.csrfToken)}
						<button type="submit" class="btn btn-danger">削除を確定する</button>
					</form>
					<a class="btn" href="/admin/agents">キャンセル</a>
				</div>
			</section>
		</div>
	`;
}

export function renderIssuedTokenBody(view: IssuedTokenView): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>参加者トークンを発行しました</h1>
				<p class="muted">対象エージェント: <strong>${view.agentName}</strong></p>
			</div>

			${
				view.revokedPrevious
					? html`
						<div class="banner banner-warning" role="status">
							以前の参加者トークンは即座に無効になりました。エージェント側の設定を新しいトークンへ差し替えてください。
						</div>
					`
					: false
			}

			<section class="card stack">
				<div class="banner banner-info">
					このトークンの平文はセキュリティ上、今この画面に一度だけ表示されます。サーバーにはハッシュ値のみが保存されるため、画面を閉じると再表示できません。
				</div>
				<div class="token-box">${view.token}</div>
				<div>
					<p>
						上のトークンをすべてコピーし、エージェントの MCP 接続設定に次のヘッダーを設定してください。
					</p>
					<ul>
						<li>接続先 URL: <code>${view.mcpUrl}</code></li>
						<li>ヘッダー: <code>Authorization: Bearer &lt;コピーしたトークン&gt;</code></li>
					</ul>
				</div>
				<div class="actions">
					<a class="btn btn-primary" href="/admin/agents">エージェント一覧へ戻る</a>
				</div>
			</section>
		</div>
	`;
}
