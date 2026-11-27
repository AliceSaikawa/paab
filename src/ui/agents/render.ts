import type { AgentWebhookSummary, AgentWithStatus } from "../../admin";
import type { WebhookAuthMode, WebhookDeliveryStatus } from "../../types";
import { csrfInput } from "../csrf";
import { html, rawHtml, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";

export interface IssuedTokenView {
	agentName: string;
	token: string;
	revokedPrevious: boolean;
	mcpUrl: string;
}

export interface IssuedUnreadTokenView {
	agentName: string;
	token: string;
	revokedPrevious: boolean;
	unreadUrl: string;
}

export interface RevealedWebhookSecretView {
	agentName: string;
	url: string;
	secret: string;
	rotated: boolean;
}

const WEBHOOK_AUTH_MODE_OPTIONS: ReadonlyArray<{
	value: WebhookAuthMode;
	label: string;
}> = [
	{
		value: "standard_webhooks",
		label: "Standard Webhooks (standard_webhooks / Grok Bot 等)",
	},
	{
		value: "bearer_header",
		label: "Bearer 認証ヘッダー (bearer_header / Manus・Cue 等)",
	},
	{
		value: "custom_header",
		label: "任意ヘッダー (custom_header)",
	},
	{
		value: "paab_hmac",
		label: "paab 独自 HMAC (paab_hmac / 鍵を自動生成)",
	},
];

function renderDeliveryStatusBadge(status: WebhookDeliveryStatus): SafeHtml {
	switch (status) {
		case "delivered":
			return html`<span class="badge badge-ok">配達済</span>`;
		case "pending":
			return html`<span class="badge">待機中</span>`;
		case "abandoned":
			return html`<span class="badge badge-danger">放棄</span>`;
	}
}

function renderWebhookSection(
	entry: AgentWithStatus,
	webhook: AgentWebhookSummary | null,
	csrfToken: string,
): SafeHtml {
	const { agent } = entry;
	const urlInputId = `webhook-url-${agent.id}`;
	const modeInputId = `webhook-auth-mode-${agent.id}`;
	const headerInputId = `webhook-header-name-${agent.id}`;
	const secretInputId = `webhook-secret-${agent.id}`;
	const selectedMode: WebhookAuthMode =
		webhook?.authMode ?? "standard_webhooks";
	const latest = webhook?.latestDelivery ?? null;

	return html`
		<div class="stack">
			<div>
				<strong>呼び出し先URL（Webhook）:</strong>
				${
					webhook === null
						? html`<span class="badge">未設定</span>`
						: html`<span class="badge badge-ok">設定済み</span>`
				}
			</div>

			${
				webhook !== null
					? html`
						<div class="muted stack">
							<div>
								URL: <code>${webhook.url}</code> / 認証方式: <code>${webhook.authMode}</code>${
									webhook.authMode === "custom_header" &&
									webhook.headerName !== null
										? html` / ヘッダー名: <code>${webhook.headerName}</code>`
										: false
								}
							</div>
							${
								latest !== null
									? html`
										<div>
											最新配達: ${renderDeliveryStatusBadge(latest.status)}
											（試行 ${latest.attempts} 回 / 更新: ${formatTimestamp(latest.updatedAt)}${
												latest.status === "pending"
													? html` / 次回予定: ${formatTimestamp(latest.nextAttemptAt)}`
													: false
											}）
											${
												latest.lastError !== null
													? html`<div>最終エラー: <code>${latest.lastError}</code></div>`
													: false
											}
										</div>
									`
									: html`<div>最新配達: まだ送信履歴はありません</div>`
							}
						</div>
					`
					: false
			}

			<form method="POST" action="${agentActionPath(agent.id, "/webhook")}">
				${csrfInput(csrfToken)}
				<div class="field">
					<label for="${urlInputId}">呼び出し先 URL（HTTPS）</label>
					<input
						id="${urlInputId}"
						type="url"
						name="url"
						maxlength="2048"
						required
						placeholder="https://example.com/webhook"
						value="${webhook?.url ?? ""}"
					>
				</div>
				<div class="grid">
					<div class="field">
						<label for="${modeInputId}">認証方式（<code>auth_mode</code>）</label>
						<select id="${modeInputId}" name="auth_mode" required>
							${WEBHOOK_AUTH_MODE_OPTIONS.map(
								(option) => html`
									<option
										value="${option.value}"${selectedMode === option.value ? rawHtml(" selected") : false}
									>
										${option.label}
									</option>
								`,
							)}
						</select>
					</div>
					<div class="field">
						<label for="${headerInputId}">カスタムヘッダー名（<code>custom_header</code> のみ）</label>
						<input
							id="${headerInputId}"
							type="text"
							name="header_name"
							maxlength="64"
							placeholder="X-Webhook-Token"
							value="${webhook?.headerName ?? ""}"
						>
					</div>
				</div>
				<div class="field">
					<label for="${secretInputId}">認証シークレット（外部認証方式用）</label>
					<input
						id="${secretInputId}"
						type="password"
						name="secret"
						maxlength="2048"
						autocomplete="new-password"
						placeholder="${
							webhook !== null && webhook.authMode !== "paab_hmac"
								? "変更する場合のみ入力（空欄で既存の秘密値を維持）"
								: "standard_webhooks は whsec_... / paab_hmac は空欄で自動生成"
						}"
					>
					<div class="muted">
						外部発行シークレットは登録後に再表示されません。<code>paab_hmac</code> は paab 側で <code>paab_whsec_</code> 鍵を自動生成し、生成・ローテーション時に一度だけ表示します。
					</div>
				</div>
				<div class="actions">
					<button type="submit" class="btn btn-primary">Webhook を保存</button>
				</div>
			</form>

			${
				webhook !== null
					? html`
						<div class="actions">
							${
								webhook.authMode === "paab_hmac"
									? html`
										<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/webhook/rotate")}">
											${csrfInput(csrfToken)}
											<button type="submit" class="btn">署名鍵をローテーション</button>
										</form>
									`
									: false
							}
							<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/webhook/delete")}">
								${csrfInput(csrfToken)}
								<button type="submit" class="btn btn-danger">Webhook を削除</button>
							</form>
						</div>
					`
					: false
			}
		</div>
	`;
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

function renderUnreadTokenSection(
	entry: AgentWithStatus,
	csrfToken: string,
): SafeHtml {
	const { agent, activeTokens } = entry;
	const token = activeTokens.unread_count;

	if (token === null) {
		return html`
			<div class="stack">
				<div>
					<strong>件数確認トークン（<code>unread_count</code>）:</strong>
					<span class="badge">未発行</span>
				</div>
				<form method="POST" action="${agentActionPath(agent.id, "/unread-token")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">件数確認トークンを発行</button>
				</form>
			</div>
		`;
	}

	return html`
		<div class="stack">
			<div>
				<strong>件数確認トークン（<code>unread_count</code>）:</strong>
				<span class="badge badge-ok">有効</span>
				<span class="muted">（発行日時: ${formatTimestamp(token.createdAt)}）</span>
			</div>
			<div class="banner banner-warning" role="note">
				注意: 件数確認トークンを再発行すると、現在有効な件数確認トークンは即座に無効になります。
			</div>
			<div class="actions">
				<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/unread-token")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-primary">件数確認トークンを再発行</button>
				</form>
				<form class="inline-form" method="POST" action="${agentActionPath(agent.id, "/unread-token/revoke")}">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-danger">件数確認トークンを失効</button>
				</form>
			</div>
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

			${renderParticipantTokenSection(entry, csrfToken)}

			${renderUnreadTokenSection(entry, csrfToken)}

			${renderWebhookSection(entry, webhook, csrfToken)}

			<div class="actions">
				${statusForm}
				<a class="btn btn-danger" href="${agentActionPath(agent.id, "/delete")}">削除…</a>
			</div>
		</section>
	`;
}

export function renderAgentsPageBody(options: {
	agents: readonly AgentWithStatus[];
	webhooksByAgentId?: ReadonlyMap<string, AgentWebhookSummary>;
	defaultOwnerId: string;
	csrfToken: string;
}): SafeHtml {
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
						options.webhooksByAgentId?.get(entry.agent.id) ?? null,
						options.csrfToken,
					),
				);

	return html`
		<div class="stack">
			<div>
				<h1>エージェント管理（${options.agents.length}件）</h1>
				<p class="muted">
					エージェントの登録・編集・停止/再開・削除と、MCP 接続用の参加者トークン・未読件数確認用の件数確認トークン発行を行います。
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
							value=""
						>
						<div class="muted">1〜64文字。改行・制御文字・カンマ（,）は使えません。</div>
					</div>
					<div class="field">
						<label for="register-description">説明文（任意）</label>
						<textarea
							id="register-description"
							name="description"
							maxlength="1000"
						></textarea>
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
							value="20"
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
							value=""
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
				<div>
					<strong>件数確認トークン:</strong>
					${activeTokens.unread_count === null ? "未発行" : "有効なトークンあり（同時に削除されます）"}
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

export function renderIssuedUnreadTokenBody(
	view: IssuedUnreadTokenView,
): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>件数確認トークン（<code>unread_count</code>）を発行しました</h1>
				<p class="muted">対象エージェント: <strong>${view.agentName}</strong></p>
			</div>

			${
				view.revokedPrevious
					? html`
						<div class="banner banner-warning" role="status">
							以前の件数確認トークンは即座に無効になりました。定期確認スクリプト側の設定を新しいトークンへ差し替えてください。
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
						このトークンは VM 上の定期確認スクリプト（ポーリング）向けに配置する前提の低権限トークンです。未読件数（<code>{"unread": 件数}</code>）のみを取得でき、メッセージ本文の閲覧や <code>/mcp</code> の呼び出しはできません。
					</p>
					<ul>
						<li>呼び出し先: <code>GET ${view.unreadUrl}</code></li>
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

export function renderRevealedWebhookSecretBody(
	view: RevealedWebhookSecretView,
): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>${view.rotated ? "Webhook 署名鍵をローテーションしました" : "Webhook 署名鍵を発行しました"}</h1>
				<p class="muted">対象エージェント: <strong>${view.agentName}</strong></p>
			</div>

			${
				view.rotated
					? html`
						<div class="banner banner-warning" role="status">
							以前の署名鍵は直ちに置き換わりました。レシーバ側の検証鍵を新しい鍵へ更新してください。
						</div>
					`
					: false
			}

			<section class="card stack">
				<div class="banner banner-info">
					この署名鍵はセキュリティ上、今この画面に一度だけ表示されます。画面を閉じると再表示できないため、今すぐ安全な場所へ控えてください。
				</div>
				<div class="token-box">${view.secret}</div>
				<div>
					<p>
						paab は新着時に次の固定ペイロードを <code>POST</code> します（メッセージ本文や送信元情報は含みません）。
					</p>
					<ul>
						<li>呼び出し先 URL: <code>${view.url}</code></li>
						<li>認証方式: <code>paab_hmac</code></li>
						<li>ボディ: <code>{"event":"inbox_wake"}</code></li>
						<li>署名ヘッダー: <code>X-Paab-Timestamp</code>（UNIX秒）と <code>X-Paab-Signature: sha256=&lt;hex&gt;</code>（<code>&lt;timestamp&gt;.&lt;raw_body&gt;</code> の HMAC-SHA256）</li>
					</ul>
				</div>
				<div class="actions">
					<a class="btn btn-primary" href="/admin/agents">エージェント一覧へ戻る</a>
				</div>
			</section>
		</div>
	`;
}
