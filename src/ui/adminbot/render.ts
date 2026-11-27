import {
	type AgentWithStatus,
	type CategoryWithUsage,
	isUndoableChangeAction,
} from "../../admin";
import {
	type AdminBotConfig,
	DEFAULT_SUPERADMIN_DAYS,
	getSuperadminState,
	SUPERADMIN_DURATION_PRESETS,
	type SuperadminState,
} from "../../adminbot";
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
	bodyRecordingEnabled: boolean;
	now: UnixMillis;
	csrfToken: string;
	adminMcpUrl: string;
}

export interface BothPermissionsConfirmView {
	agentName: string;
	action: string;
	hiddenFields: readonly { name: string; value: string }[];
	enablingLabel: string;
	alreadyEnabledLabel: string;
	csrfToken: string;
}

export interface IssuedAdminTokenView {
	agentName: string;
	token: string;
	revokedPrevious: boolean;
	adminMcpUrl: string;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function formatRemainingDuration(remainingMs: number): string {
	if (remainingMs >= DAY_MS) {
		const days = Math.floor(remainingMs / DAY_MS);
		const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
		return `残り ${days}日 ${hours}時間`;
	}
	if (remainingMs >= HOUR_MS) {
		const hours = Math.floor(remainingMs / HOUR_MS);
		const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
		return `残り ${hours}時間 ${minutes}分`;
	}
	if (remainingMs >= MINUTE_MS) {
		const minutes = Math.floor(remainingMs / MINUTE_MS);
		return `残り ${minutes}分`;
	}
	return "残り 1分未満";
}

function superadminSummaryLabel(state: SuperadminState): string {
	switch (state.kind) {
		case "off":
			return "オフ";
		case "expired":
			return "期限切れ（オフ）";
		case "active":
			return "有効";
		case "permanent":
			return "有効（無期限）";
	}
}

function renderSuperadminBadge(state: SuperadminState): SafeHtml {
	switch (state.kind) {
		case "off":
			return html`<span class="badge">オフ</span>`;
		case "expired":
			return html`<span class="badge">期限切れ（オフ）</span>`;
		case "active":
			return html`<span class="badge badge-dev">有効</span>`;
		case "permanent":
			return html`<span class="badge badge-danger">有効（無期限）</span>`;
	}
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
			</section>
		`;
	}

	const { agent } = designated;
	const superadminState = getSuperadminState(config, view.now);
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
			<div class="muted">
				任意の権限（既定はオフ）: 本文閲覧 <strong>${config.readBodies ? "オン" : "オフ"}</strong> / 最高管理者権限 <strong>${superadminSummaryLabel(superadminState)}</strong>
			</div>

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

function renderReadBodiesPermission(view: AdminBotPageView): SafeHtml {
	const { config, bodyRecordingEnabled, csrfToken } = view;
	const enabled = config.readBodies;
	const nextValue = enabled ? "0" : "1";
	const buttonLabel = enabled ? "本文閲覧をオフにする" : "本文閲覧をオンにする";
	const buttonClass = enabled ? "btn" : "btn btn-primary";
	const statusBadge = enabled
		? html`<span class="badge badge-dev">オン</span>`
		: html`<span class="badge">オフ</span>`;

	return html`
		<div class="card stack">
			<div class="actions">
				<h3 style="margin: 0;">本文閲覧</h3>
				${statusBadge}
			</div>
			<p class="muted">
				<code>view_audit_log</code> で監査ログに記録された質問文・回答文を読めるようにします。本文は外部データ枠（<code>&lt;untrusted_external_data&gt;</code>）に入れて渡し、読んだ記録を監査ログ（<code>admin_body_read</code>）に残します。
			</p>
			<div class="actions">
				<form class="inline-form" method="POST" action="/admin/adminbot/permissions/read-bodies">
					${csrfInput(csrfToken)}
					<input type="hidden" name="enabled" value="${nextValue}">
					<button type="submit" class="${buttonClass}">${buttonLabel}</button>
				</form>
				<span class="muted">
					注意: 本文閲覧をオンにすると、質問文・回答文に含まれる外部テキストを管理者ボットが読むため、プロンプトインジェクションの影響を受けるおそれがあります。
				</span>
			</div>
			${
				!bodyRecordingEnabled
					? html`
						<div class="banner banner-info" role="status">
							監査ログへの本文記録（<code>AUDIT_RECORD_BODIES</code>）が無効のため、このスイッチをオンにしても読める本文はありません。
						</div>
					`
					: false
			}
		</div>
	`;
}

function renderSuperadminPermission(view: AdminBotPageView): SafeHtml {
	const { config, now, csrfToken } = view;
	const state = getSuperadminState(config, now);
	const isActive = state.kind === "active" || state.kind === "permanent";
	const submitLabel = isActive
		? "最高管理者権限の有効期間を更新する"
		: "最高管理者権限をオンにする";

	let stateDetail: SafeHtml | false = false;
	if (state.kind === "active") {
		stateDetail = html`
			<span class="muted">（${formatRemainingDuration(state.remainingMs)} / 有効期限: ${formatTimestamp(state.until)}）</span>
		`;
	} else if (state.kind === "expired") {
		stateDetail = html`
			<span class="muted">（期限切れ: ${formatTimestamp(state.expiredAt)}）</span>
		`;
	} else if (state.kind === "permanent") {
		stateDetail = html`
			<span class="muted">（有効期限なし・手動でオフにするまで有効）</span>
		`;
	}

	return html`
		<div class="card stack">
			<div class="actions">
				<h3 style="margin: 0;">最高管理者権限</h3>
				${renderSuperadminBadge(state)}
				${stateDetail}
			</div>
			<p class="muted">
				通常は提案までとなる緩める操作（許可ルール追加・カテゴリ追加・1日の質問数上限引き上げ・停止中エージェントの再開）を、承認なしで単独実行できるようにします。有効期限が過ぎた時点で自動的に無効になり、トークンの発行・再発行、管理者の指名替え、自分の権限設定の変更、監査ログの停止・削除は有効中でも実行できません。
			</p>
			<div class="banner banner-warning" role="note">
				<strong>把握しているリスク（設計書 5.3 節）:</strong>
				管理者ボットは参加者を兼ねるため、参加者として受け取った質問文に仕込まれたプロンプトインジェクション経由で管理者としての操作を実行させられる可能性があります。最高管理者権限が有効なときは、全カテゴリの開示許可につながり得ます。有効期限、固定の禁止操作、変更履歴の記録と 1 操作での取消はこの被害を限定するためのものです。
			</div>
			<div class="actions">
				<form class="inline-form" method="POST" action="/admin/adminbot/permissions/superadmin">
					${csrfInput(csrfToken)}
					<div class="actions">
						<label for="adminbot-superadmin-duration">有効期間</label>
						<select id="adminbot-superadmin-duration" name="duration" style="width: auto;">
							${SUPERADMIN_DURATION_PRESETS.map(
								(days) =>
									html`<option value="${String(days)}"${days === DEFAULT_SUPERADMIN_DAYS ? rawHtml(" selected") : false}>${days}日${days === DEFAULT_SUPERADMIN_DAYS ? "（既定）" : ""}</option>`,
							)}
							<option value="permanent">無期限</option>
						</select>
						<button type="submit" class="btn btn-primary">${submitLabel}</button>
					</div>
				</form>
				${
					isActive
						? html`
							<form class="inline-form" method="POST" action="/admin/adminbot/permissions/superadmin">
								${csrfInput(csrfToken)}
								<input type="hidden" name="duration" value="off">
								<button type="submit" class="btn">最高管理者権限をオフにする</button>
							</form>
						`
						: false
				}
			</div>
		</div>
	`;
}

function renderOptionalPermissionsSection(
	view: AdminBotPageView,
): SafeHtml | false {
	if (view.designated === null) {
		return false;
	}

	return html`
		<section class="card stack">
			<div>
				<h2>任意の権限</h2>
				<p class="muted">
					管理者ボットに追加できる任意の権限です（既定はオフ）。この画面から所有者のみが切り替えられます。
				</p>
			</div>
			<div class="stack">
				${renderReadBodiesPermission(view)}
				${renderSuperadminPermission(view)}
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
												<td>
													${CHANGE_ACTION_LABELS[entry.action]}
													${
														entry.approverId !== null
															? html` <span class="muted">（承認: ${entry.approverId}）</span>`
															: false
													}
												</td>
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
			${renderOptionalPermissionsSection(view)}
			${renderDesignateSection(view)}
			${renderAdminBotChangesSection(view)}
		</div>
	`;
}

/** Renders the 1-step confirmation screen when enabling both optional permissions at once (design section 5.3). */
export function renderBothPermissionsConfirmBody(
	view: BothPermissionsConfirmView,
): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>本文閲覧と最高管理者権限の同時有効化の確認</h1>
				<p class="muted"><a href="/admin/adminbot">管理者ボット設定へ戻る</a></p>
			</div>
			<section class="card stack">
				<p>
					対象エージェント: <strong>${view.agentName}</strong>
				</p>
				<p>
					現在 <strong>${view.alreadyEnabledLabel}</strong> が有効です。ここで <strong>${view.enablingLabel}</strong> をオンにすると、本文閲覧と最高管理者権限の両方が同時に有効になります。
				</p>
				<div class="banner banner-warning" role="alert">
					<strong>把握しているリスク（設計書 5.3 節）:</strong>
					本文閲覧と最高管理者権限を同時に有効にすると、管理者ボットが監査ログの質問文・回答文（外部データ）を読んだ結果としてプロンプトインジェクションを受け、全カテゴリの許可ルール追加など緩める操作を単独で実行してしまうおそれがあります。必要に応じて有効期限を短く設定し、不要になったらオフにしてください。
				</div>
				<form method="POST" action="${view.action}" class="actions">
					${csrfInput(view.csrfToken)}
					${view.hiddenFields.map(
						(field) =>
							html`<input type="hidden" name="${field.name}" value="${field.value}">`,
					)}
					<button type="submit" class="btn btn-danger">リスクを理解して両方オンにする</button>
					<a class="btn" href="/admin/adminbot">キャンセル</a>
				</form>
			</section>
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
