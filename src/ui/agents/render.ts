import type { AgentWithStatus } from "../../admin";
import type { AgentWebhookSummary } from "../../types";
import { csrfInput } from "../csrf";
import { html, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";

export type AgentUiTokenPurpose = "participant" | "unread_count";

export interface AgentTokenUiConfig {
	label: string;
	note: string | null;
	issuePathSuffix: string;
	revokePathSuffix: string;
	endpointPath: string;
	issueButtonLabel: string;
	reissueButtonLabel: string;
	revokeButtonLabel: string;
	reissueWarning: string;
	issuedPageTitle: string;
	issuedHeading: string;
	issuedFlashVerb: string;
	revokedPreviousWarning: string;
	revokedFlashMessage: string;
	noActiveRevokeMessage: string;
}

export const AGENT_TOKEN_UI_CONFIG: Record<
	AgentUiTokenPurpose,
	AgentTokenUiConfig
> = {
	participant: {
		label: "参加者トークン",
		note: null,
		issuePathSuffix: "/token",
		revokePathSuffix: "/token/revoke",
		endpointPath: "/mcp",
		issueButtonLabel: "参加者トークンを発行",
		reissueButtonLabel: "参加者トークンを再発行",
		revokeButtonLabel: "参加者トークンを失効",
		reissueWarning:
			"注意: 参加者トークンを再発行すると、現在有効なトークンは即座に無効になります。",
		issuedPageTitle: "参加者トークン発行",
		issuedHeading: "参加者トークンを発行しました",
		issuedFlashVerb: "参加者トークンを発行しました",
		revokedPreviousWarning:
			"以前の参加者トークンは即座に無効になりました。エージェント側の設定を新しいトークンへ差し替えてください。",
		revokedFlashMessage: "参加者トークンを失効させました",
		noActiveRevokeMessage: "有効な参加者トークンはありませんでした",
	},
	unread_count: {
		label: "件数確認トークン（/unread）",
		note: "VM 上の定期確認スクリプト向け。未読件数のみ取得でき、質問・回答の本文は読めません。",
		issuePathSuffix: "/unread-token",
		revokePathSuffix: "/unread-token/revoke",
		endpointPath: "/unread",
		issueButtonLabel: "件数確認トークンを発行",
		reissueButtonLabel: "件数確認トークンを再発行",
		revokeButtonLabel: "件数確認トークンを失効",
		reissueWarning:
			"注意: 件数確認トークンを再発行すると、現在有効な件数確認トークンは即座に無効になります（参加者トークンには影響しません）。",
		issuedPageTitle: "件数確認トークン発行",
		issuedHeading: "件数確認トークンを発行しました",
		issuedFlashVerb: "件数確認トークン（/unread）を発行しました",
		revokedPreviousWarning:
			"以前の件数確認トークンは即座に無効になりました。VM 上の定期確認スクリプトの設定を新しいトークンへ差し替えてください。",
		revokedFlashMessage: "件数確認トークンを失効させました",
		noActiveRevokeMessage: "有効な件数確認トークンはありませんでした",
	},
};

export const AGENT_UI_TOKEN_PURPOSES: readonly AgentUiTokenPurpose[] = [
	"participant",
	"unread_count",
];

export interface RegisterFormDraft {
	name: string;
	description: string;
	dailyQuestionLimit: string;
	ownerId: string;
}

export interface IssuedTokenView {
	purpose: AgentUiTokenPurpose;
	agentName: string;
	token: string;
	revokedPrevious: boolean;
	endpointUrl: string;
}

export interface ConfiguredWebhookView {
	agentName: string;
	url: string;
	signingSecret: string;
	replacedPrevious: boolean;
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

function renderAgentTokenSection(
	entry: AgentWithStatus,
	purpose: AgentUiTokenPurpose,
	csrfToken: string,
): SafeHtml {
	const { agent, activeTokens } = entry;
	const token = activeTokens[purpose];
	const config = AGENT_TOKEN_UI_CONFIG[purpose];
	const note =
		config.note !== null
			? html`<div class="muted">${config.note}</div>`
			: false;

	if (token === null) {
		return html`
			<div class="stack">
				<div>
					<strong>${config.label}:</strong>
					<span class="badge">未発行</span>
				</div>
				${note}
				<form method="POST" action="${agentActionPath(agent.id, config.issuePathSuffix)}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">${config.issueButtonLabel}</button>
				</form>
			</div>
		`;
	}

	return html`
		<div class="stack">
			<div>
				<strong>${config.label}:</strong>
				<span class="badge badge-ok">有効</span>
				<span class="muted">（発行日時: ${formatTimestamp(token.createdAt)}）</span>
			</div>
			${note}
			<div class="banner banner-warning" role="note">
				${config.reissueWarning}
			</div>
			<div class="actions">
				<form class="inline-form" method="POST" action="${agentActionPath(agent.id, config.issuePathSuffix)}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">${config.reissueButtonLabel}</button>
				</form>
				<form class="inline-form" method="POST" action="${agentActionPath(agent.id, config.revokePathSuffix)}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-danger">${config.revokeButtonLabel}</button>
				</form>
			</div>
		</div>
	`;
}

function renderWebhookSection(
	agent: AgentWithStatus["agent"],
	webhook: AgentWebhookSummary | null,
	csrfToken: string,
): SafeHtml {
	const urlInputId = `agent-webhook-url-${agent.id}`;

	if (webhook === null) {
		return html`
			<div class="stack">
				<div>
					<strong>Webhook 通知:</strong>
					<span class="badge">未設定</span>
				</div>
				<form method="POST" action="${agentActionPath(agent.id, "/webhook")}">
					${csrfInput(csrfToken)}
					<div class="field">
						<label for="${urlInputId}">呼び出し先 URL</label>
						<input
							id="${urlInputId}"
							type="url"
							name="url"
							maxlength="2048"
							placeholder="https://agent.example/webhook"
							required
						>
						<div class="muted">
							新着時に本文を含まない署名付き通知を送信します（HTTPS のみ、ローカル・内部宛先不可）。
						</div>
					</div>
					<button type="submit" class="btn btn-primary">Webhook を登録</button>
				</form>
			</div>
		`;
	}

	return html`
		<div class="stack">
			<div>
				<strong>Webhook 通知:</strong>
				<span class="badge badge-ok">設定済み</span>
				<span class="muted">（更新日時: ${formatTimestamp(webhook.updatedAt)}）</span>
			</div>
			<div class="muted">
				呼び出し先 URL: <code>${webhook.url}</code>
			</div>
			<div class="banner banner-warning" role="note">
				注意: URL の更新または署名鍵の再発行を行うと、現在有効な署名鍵は即座に無効になります。
			</div>
			<form method="POST" action="${agentActionPath(agent.id, "/webhook")}">
				${csrfInput(csrfToken)}
				<div class="field">
					<label for="${urlInputId}">呼び出し先 URL</label>
					<input
						id="${urlInputId}"
						type="url"
						name="url"
						maxlength="2048"
						value="${webhook.url}"
						required
					>
				</div>
				<div class="actions">
					<button type="submit" class="btn btn-primary">URL を更新・署名鍵を再発行</button>
				</div>
			</form>
			<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/webhook/delete")}">
				${csrfInput(csrfToken)}
				<button type="submit" class="btn btn-danger">Webhook を削除</button>
			</form>
		</div>
	`;
}

function renderAgentCard(
	entry: AgentWithStatus,
	webhook: AgentWebhookSummary | null,
	csrfToken: string,
): SafeHtml {
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

			${AGENT_UI_TOKEN_PURPOSES.map((purpose) =>
				renderAgentTokenSection(entry, purpose, csrfToken),
			)}

			${renderWebhookSection(agent, webhook, csrfToken)}

			<div class="actions">
				${statusForm}
				<a class="btn btn-danger" href="${agentActionPath(agent.id, "/delete")}">削除…</a>
			</div>
		</section>
	`;
}

export function renderAgentsPageBody(options: {
	agents: readonly AgentWithStatus[];
	webhooks?: ReadonlyMap<string, AgentWebhookSummary>;
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
					renderAgentCard(
						entry,
						options.webhooks?.get(entry.agent.id) ?? null,
						options.csrfToken,
					),
				);

	return html`
		<div class="stack">
			<div>
				<h1>エージェント管理（${options.agents.length}件）</h1>
				<p class="muted">
					エージェントの登録・編集・停止/再開・削除と、MCP 接続用の参加者トークン・定期確認用の件数確認トークン（<code>/unread</code>）の発行を行います。
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
				${AGENT_UI_TOKEN_PURPOSES.map(
					(purpose) => html`
						<div>
							<strong>${AGENT_TOKEN_UI_CONFIG[purpose].label}:</strong>
							${activeTokens[purpose] === null ? "未発行" : "有効なトークンあり（同時に削除されます）"}
						</div>
					`,
				)}
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

function renderUsageInstructions(view: IssuedTokenView): SafeHtml {
	if (view.purpose === "participant") {
		return html`
			<div>
				<p>
					上のトークンをすべてコピーし、エージェントの MCP 接続設定に次のヘッダーを設定してください。
				</p>
				<ul>
					<li>接続先 URL: <code>${view.endpointUrl}</code></li>
					<li>ヘッダー: <code>Authorization: Bearer &lt;コピーしたトークン&gt;</code></li>
				</ul>
			</div>
		`;
	}
	return html`
		<div>
			<p>
				上のトークンをすべてコピーし、VM 上の定期確認スクリプトに設定してください。このトークンは <code>/unread</code> で未読件数を確認する専用であり、質問・回答の本文は取得できません（参加者用の <code>/mcp</code> トークンとは別です）。
			</p>
			<ul>
				<li>接続先 URL: <code>GET ${view.endpointUrl}</code></li>
				<li>ヘッダー: <code>Authorization: Bearer &lt;コピーしたトークン&gt;</code></li>
				<li>確認例: <code>curl -s ${view.endpointUrl} -H "Authorization: Bearer &lt;コピーしたトークン&gt;"</code></li>
			</ul>
		</div>
	`;
}

export function renderIssuedTokenBody(view: IssuedTokenView): SafeHtml {
	const config = AGENT_TOKEN_UI_CONFIG[view.purpose];

	return html`
		<div class="stack">
			<div>
				<h1>${config.issuedHeading}</h1>
				<p class="muted">対象エージェント: <strong>${view.agentName}</strong></p>
			</div>

			${
				view.revokedPrevious
					? html`
						<div class="banner banner-warning" role="status">
							${config.revokedPreviousWarning}
						</div>
					`
					: false
			}

			<section class="card stack">
				<div class="banner banner-info">
					このトークンの平文はセキュリティ上、今この画面に一度だけ表示されます。サーバーにはハッシュ値のみが保存されるため、画面を閉じると再表示できません。
				</div>
				<div class="token-box">${view.token}</div>
				${renderUsageInstructions(view)}
				<div class="actions">
					<a class="btn btn-primary" href="/admin/agents">エージェント一覧へ戻る</a>
				</div>
			</section>
		</div>
	`;
}

const HMAC_VERIFICATION_SNIPPET = `import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyPaabWebhook(
	rawBody: string,
	timestampHeader: string,
	signatureHeader: string,
	signingSecret: string,
): boolean {
	const ts = Number(timestampHeader);
	if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
		return false;
	}
	const expected = "sha256=" + createHmac("sha256", signingSecret)
		.update(\`\${timestampHeader}.\${rawBody}\`)
		.digest("hex");
	const a = Buffer.from(signatureHeader);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}`;

export function renderConfiguredWebhookBody(
	view: ConfiguredWebhookView,
): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>Webhook を設定しました</h1>
				<p class="muted">対象エージェント: <strong>${view.agentName}</strong></p>
			</div>

			${
				view.replacedPrevious
					? html`
						<div class="banner banner-warning" role="status">
							以前の署名鍵は即座に無効になりました。受信側エンドポイントの検証用シークレットを新しい値へ差し替えてください。
						</div>
					`
					: false
			}

			<section class="card stack">
				<div class="banner banner-info">
					この署名鍵（signing_secret）の平文はセキュリティ上、今この画面に一度だけ表示されます。サーバーでは再表示できないため、この場で控えてください。
				</div>
				<div>
					<strong>呼び出し先 URL:</strong>
					<code>${view.url}</code>
				</div>
				<div class="token-box">${view.signingSecret}</div>
				<div>
					<p>
						新着時、paab は次の固定 JSON を <code>POST</code> し、<code>X-Paab-Timestamp</code> と <code>X-Paab-Signature</code> で署名します。本文やメッセージ ID は含みません。
					</p>
					<ul>
						<li>送信ボディ（固定）: <code>{"event":"inbox_wake"}</code></li>
						<li><code>X-Paab-Timestamp</code>: UNIX 秒の文字列</li>
						<li><code>X-Paab-Signature</code>: <code>sha256=&lt;HMAC-SHA256 hex(&quot;&lt;timestamp&gt;.&lt;body&gt;&quot;)&gt;</code></li>
					</ul>
					<pre class="token-box"><code>${HMAC_VERIFICATION_SNIPPET}</code></pre>
				</div>
				<div class="actions">
					<a class="btn btn-primary" href="/admin/agents">エージェント一覧へ戻る</a>
				</div>
			</section>
		</div>
	`;
}
