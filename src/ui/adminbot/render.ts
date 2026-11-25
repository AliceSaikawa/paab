import {
	type AgentWithStatus,
	type CategoryWithUsage,
	isUndoableChangeAction,
} from "../../admin";
import type { AdminBotConfig } from "../../adminbot";
import type { ChangeLogEntry, UnixMillis } from "../../types";
import { csrfInput } from "../csrf";
import { html, rawHtml, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";
import {
	CHANGE_ACTION_LABELS,
	collectEntityNames,
	describeChangeBeforeAfter,
	describeChangeTarget,
} from "../rules/render";

export interface AdminBotPageView {
	config: AdminBotConfig;
	designated: AgentWithStatus | null;
	agents: readonly AgentWithStatus[];
	categories: readonly CategoryWithUsage[];
	changes: readonly ChangeLogEntry[];
	csrfToken: string;
	adminMcpUrl: string;
	bodyRecordingEnabled: boolean;
	now: UnixMillis;
}

export interface ReadBodiesConfirmView {
	agentName: string;
	csrfToken: string;
	superadminUntil: UnixMillis;
	bodyRecordingEnabled: boolean;
}

export interface IssuedAdminTokenView {
	agentName: string;
	token: string;
	revokedPrevious: boolean;
	adminMcpUrl: string;
}

function renderStatusBadge(
	status: AgentWithStatus["agent"]["status"],
): SafeHtml {
	return status === "active"
		? html`<span class="badge badge-ok">有効</span>`
		: html`<span class="badge badge-danger">停止中</span>`;
}

function renderAdminTokenSection(
	designated: AgentWithStatus,
	csrfToken: string,
): SafeHtml {
	const { agent, activeTokens } = designated;
	const token = activeTokens.admin;

	if (token === null) {
		return html`
			<div class="stack">
				<div>
					<strong>管理者トークン:</strong>
					<span class="badge">未発行</span>
				</div>
				<form method="POST" action="/admin/adminbot/token">
					${csrfInput(csrfToken)}
					<input type="hidden" name="agent_id" value="${agent.id}">
					<button type="submit" class="btn btn-primary">管理者トークンを発行</button>
				</form>
			</div>
		`;
	}

	return html`
		<div class="stack">
			<div>
				<strong>管理者トークン:</strong>
				<span class="badge badge-ok">有効</span>
				<span class="muted">（発行日時: ${formatTimestamp(token.createdAt)}）</span>
			</div>
			<div class="banner banner-warning" role="note">
				注意: 管理者トークンを再発行すると、現在有効な管理者トークンは即座に無効になります。
			</div>
			<div class="actions">
				<form class="inline-form" method="POST" action="/admin/adminbot/token">
					${csrfInput(csrfToken)}
					<input type="hidden" name="agent_id" value="${agent.id}">
					<button type="submit" class="btn btn-primary">管理者トークンを再発行</button>
				</form>
				<form class="inline-form" method="POST" action="/admin/adminbot/token/revoke">
					${csrfInput(csrfToken)}
					<input type="hidden" name="agent_id" value="${agent.id}">
					<button type="submit" class="btn btn-danger">管理者トークンを失効</button>
				</form>
			</div>
		</div>
	`;
}

export function activeSuperadminUntil(
	config: AdminBotConfig,
	now: UnixMillis,
): UnixMillis | null {
	return config.superadminUntil !== null && config.superadminUntil > now
		? config.superadminUntil
		: null;
}

function renderBodyRecordingNotice(
	bodyRecordingEnabled: boolean,
): SafeHtml | false {
	if (bodyRecordingEnabled) {
		return false;
	}
	return html`
		<div class="banner banner-info" role="note">
			監査ログへの本文記録（<code>AUDIT_RECORD_BODIES</code>）が現在オフ（または保持日数未設定）のため、本文閲覧を有効にしても読み取れる本文は保存されていません。
		</div>
	`;
}

function renderPermissionsSection(view: AdminBotPageView): SafeHtml {
	const { config, bodyRecordingEnabled, csrfToken, now } = view;
	const nextEnabled = config.readBodies ? "0" : "1";
	const buttonLabel = config.readBodies ? "オフにする" : "オンにする";
	const buttonClass = config.readBodies ? "btn" : "btn btn-primary";
	const superadminActive = activeSuperadminUntil(config, now) !== null;

	return html`
		<div class="stack">
			<div class="actions">
				<strong>本文閲覧:</strong>
				<span class="${config.readBodies ? "badge badge-ok" : "badge"}">${config.readBodies ? "オン" : "オフ"}</span>
				<form class="inline-form" method="POST" action="/admin/adminbot/read-bodies">
					${csrfInput(csrfToken)}
					<input type="hidden" name="enabled" value="${nextEnabled}">
					<button type="submit" class="${buttonClass}">${buttonLabel}</button>
				</form>
				<span class="muted">質問文や回答文に個人情報が含まれる可能性があるため、調査が必要な間だけ有効にしてください。</span>
			</div>
			${renderBodyRecordingNotice(bodyRecordingEnabled)}
			<div class="muted">
				最高管理者権限: <strong>${superadminActive ? "有効" : "オフ"}</strong>
			</div>
		</div>
	`;
}

function renderCurrentSection(view: AdminBotPageView): SafeHtml {
	const { config, designated, csrfToken, adminMcpUrl } = view;

	if (designated === null) {
		return html`
			<section class="card stack">
				<div class="actions">
					<h2 style="margin: 0;">現在の管理者ボット</h2>
					<span class="badge">未指名</span>
				</div>
				<p class="muted">
					管理者ボットはまだ指名されていません。下のフォームから登録済みエージェントを 1 体だけ指名してください。
				</p>
				${renderBodyRecordingNotice(view.bodyRecordingEnabled)}
			</section>
		`;
	}

	const { agent } = designated;
	const suspendedBanner =
		agent.status === "suspended"
			? html`
				<div class="banner banner-warning" role="status">
					このエージェントは現在停止中のため、<code>/mcp/admin</code> への接続は HTTP 403 で拒否されます。
				</div>
			`
			: false;

	return html`
		<section class="card stack">
			<div class="actions">
				<h2 style="margin: 0;">現在の管理者ボット: ${agent.name}</h2>
				${renderStatusBadge(agent.status)}
				${
					config.updatedAt > 0
						? html`<span class="muted">更新日時: ${formatTimestamp(config.updatedAt)}</span>`
						: false
				}
			</div>

			${suspendedBanner}

			<div class="muted">
				管理者用 MCP 接続先: <code>${adminMcpUrl}</code>
			</div>
			${renderPermissionsSection(view)}

			${renderAdminTokenSection(designated, csrfToken)}

			<div class="stack">
				<p class="muted">
					指名を解除すると、現在の管理者トークンは直ちに失効し、権限スイッチもオフにリセットされます。
				</p>
				<form class="inline-form" method="POST" action="/admin/adminbot/clear">
					${csrfInput(csrfToken)}
					<button type="submit" class="btn btn-danger">指名を解除する</button>
				</form>
			</div>
		</section>
	`;
}

function renderDesignateSection(view: AdminBotPageView): SafeHtml {
	const { config, agents, csrfToken } = view;
	const heading =
		view.designated === null ? "管理者ボットを指名" : "管理者ボットを変更";
	const buttonLabel =
		view.designated === null
			? "管理者ボットに指名する"
			: "管理者ボットを変更する";

	return html`
		<section class="card stack">
			<h2>${heading}</h2>
			<div class="banner banner-warning" role="note">
				注意: 管理者ボットを変更または指名解除すると、前の管理者ボットの管理者トークンは直ちに失効し、本文閲覧・最高管理者権限スイッチはオフにリセットされます。
			</div>
			${
				agents.length === 0
					? html`
						<p class="muted">
							登録されているエージェントがありません。先に<a href="/admin/agents">エージェント管理</a>からエージェントを登録してください。
						</p>
					`
					: html`
						<form method="POST" action="/admin/adminbot/designate">
							${csrfInput(csrfToken)}
							<div class="field">
								<label for="adminbot-agent-id">指名するエージェント</label>
								<select id="adminbot-agent-id" name="agent_id" required>
									<option value="">選択してください</option>
									${agents.map((item) => {
										const isCurrent = config.agentId === item.agent.id;
										const suffix = [
											isCurrent ? "現在の管理者ボット" : null,
											item.agent.status === "suspended" ? "停止中" : null,
										]
											.filter((part): part is string => part !== null)
											.join("・");
										return html`
											<option
												value="${item.agent.id}"${isCurrent ? rawHtml(" selected") : false}
											>
												${item.agent.name}${suffix.length > 0 ? `（${suffix}）` : ""}
											</option>
										`;
									})}
								</select>
							</div>
							<button type="submit" class="btn btn-primary">${buttonLabel}</button>
						</form>
					`
			}
		</section>
	`;
}

function renderAdminBotChangesSection(view: AdminBotPageView): SafeHtml {
	const names = collectEntityNames(view.agents, view.categories, view.changes);

	return html`
		<section class="card stack">
			<div>
				<h2>管理者ボットによる変更履歴</h2>
				<p class="muted">
					管理者ボットが実行した変更を新しい順に表示します。最新の変更から 1 操作で元に戻せます。
				</p>
			</div>
			${
				view.changes.length === 0
					? html`<p class="muted">管理者ボットによる変更履歴はまだありません。</p>`
					: html`
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>ID</th>
										<th>日時</th>
										<th>操作</th>
										<th>対象</th>
										<th>変更内容</th>
										<th>取消</th>
									</tr>
								</thead>
								<tbody>
									${view.changes.map(
										(entry) => html`
											<tr>
												<td>#${entry.id}</td>
												<td>${formatTimestamp(entry.occurredAt)}</td>
												<td>${CHANGE_ACTION_LABELS[entry.action]}</td>
												<td>${describeChangeTarget(entry, names)}</td>
												<td>${describeChangeBeforeAfter(entry, names)}</td>
												<td>
													${
														entry.revertedAt !== null
															? html`
																<span class="badge">元に戻しました</span>
																<span class="muted">（${formatTimestamp(entry.revertedAt)}）</span>
															`
															: isUndoableChangeAction(entry.action)
																? html`
																	<form
																		class="inline-form"
																		method="POST"
																		action="/admin/adminbot/changes/${entry.id}/revert"
																	>
																		${csrfInput(view.csrfToken)}
																		<button type="submit" class="btn btn-danger">元に戻す</button>
																	</form>
																`
																: html`<span class="badge">取消不可</span>`
													}
												</td>
											</tr>
										`,
									)}
								</tbody>
							</table>
						</div>
					`
			}
		</section>
	`;
}

/** Renders the `/admin/adminbot` management screen. */
export function renderAdminBotPageBody(view: AdminBotPageView): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>管理者ボット</h1>
				<p class="muted">
					ブリッジ管理用の接続（<code>/mcp/admin</code>）を使う管理者ボットを 1 体だけ指名し、管理者トークンを管理します。参加者としての接続（<code>/mcp</code>）とはトークンを分けて使います。
				</p>
			</div>
			${renderCurrentSection(view)}
			${renderDesignateSection(view)}
			${renderAdminBotChangesSection(view)}
		</div>
	`;
}

/** Renders the one-time plaintext token screen after issuing an admin token. */
export function renderIssuedAdminTokenBody(
	view: IssuedAdminTokenView,
): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>管理者トークンを発行しました</h1>
				<p class="muted">対象エージェント: <strong>${view.agentName}</strong></p>
			</div>

			${
				view.revokedPrevious
					? html`
						<div class="banner banner-warning" role="status">
							以前の管理者トークンは即座に無効になりました。管理者ボット側の設定を新しいトークンへ差し替えてください。
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
						上のトークンをすべてコピーし、管理者ボット用の MCP 接続設定に次のヘッダーを設定してください（参加者用の <code>/mcp</code> トークンとは別です）。
					</p>
					<ul>
						<li>接続先 URL: <code>${view.adminMcpUrl}</code></li>
						<li>ヘッダー: <code>Authorization: Bearer &lt;コピーしたトークン&gt;</code></li>
					</ul>
				</div>
				<div class="actions">
					<a class="btn btn-primary" href="/admin/adminbot">管理者ボット設定へ戻る</a>
				</div>
			</section>
		</div>
	`;
}

/**
 * Renders the 1-step confirmation screen when enabling `read_bodies` while
 * `superadmin` is active (design 5.3).
 */
export function renderReadBodiesConfirmBody(
	view: ReadBodiesConfirmView,
): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>本文閲覧の有効化確認</h1>
				<p class="muted">対象エージェント: <strong>${view.agentName}</strong></p>
			</div>

			<section class="card stack">
				<div class="banner banner-warning" role="alert">
					現在、最高管理者権限（有効期限: ${formatTimestamp(view.superadminUntil)}）が有効です。本文閲覧を同時にオンにすると、外部から届いた質問文・回答文の内容を読んだ管理者ボットが単独で設定変更を行える状態になります。
				</div>
				<p class="muted">
					質問文や回答文に個人情報が含まれる可能性があるため、調査が必要な間だけ有効にしてください。
				</p>
				${renderBodyRecordingNotice(view.bodyRecordingEnabled)}
				<form method="POST" action="/admin/adminbot/read-bodies" class="actions">
					${csrfInput(view.csrfToken)}
					<input type="hidden" name="enabled" value="1">
					<input type="hidden" name="confirm" value="1">
					<button type="submit" class="btn btn-primary">理解したうえでオンにする</button>
					<a class="btn" href="/admin/adminbot">キャンセル</a>
				</form>
			</section>
		</div>
	`;
}
