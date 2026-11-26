import type {
	AgentWithStatus,
	AllowRuleGroup,
	CategoryWithUsage,
} from "../../admin";
import type { Category, ChangeAction, ChangeLogEntry } from "../../types";
import { csrfInput } from "../csrf";
import { html, rawHtml, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";

export interface RulesPageFormValues {
	fromAgentId?: string;
	toAgentId?: string;
	categoryId?: string;
	categoryName?: string;
}

export interface RulesPageData {
	csrfToken: string;
	ruleGroups: readonly AllowRuleGroup[];
	agents: readonly AgentWithStatus[];
	categories: readonly CategoryWithUsage[];
	changeLog: readonly ChangeLogEntry[];
	formValues?: RulesPageFormValues;
}

export interface DeleteCategoryConfirmData {
	csrfToken: string;
	category: Category;
	allowRuleCount: number;
}

export interface ChangeLogNameMaps {
	agents: Map<string, string>;
	categories: Map<string, string>;
}

export const CHANGE_ACTION_LABELS: Record<ChangeAction, string> = {
	agent_registered: "エージェント登録",
	agent_updated: "エージェント更新",
	agent_deleted: "エージェント削除",
	agent_suspended: "エージェント停止",
	agent_resumed: "エージェント再開",
	token_issued: "トークン発行",
	token_revoked: "トークン失効",
	category_created: "カテゴリ追加",
	category_deleted: "カテゴリ削除",
	allow_rule_granted: "許可ルール追加",
	allow_rule_revoked: "許可ルール取消",
	admin_bot_designated: "管理者ボット指名",
	admin_bot_cleared: "管理者ボット解除",
	admin_bot_switches_updated: "管理者ボット権限変更",
	change_reverted: "変更取消",
	description_approved: "説明文承認",
	description_rejected: "説明文却下",
	webhook_configured: "Webhook設定",
	webhook_deleted: "Webhook削除",
};

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function readString(
	record: Record<string, unknown> | null,
	key: string,
): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readRecord(
	record: Record<string, unknown> | null,
	key: string,
): Record<string, unknown> | null {
	const value = record?.[key];
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function readArrayLength(
	record: Record<string, unknown> | null,
	key: string,
): number | null {
	const value = record?.[key];
	return Array.isArray(value) ? value.length : null;
}

export function collectEntityNames(
	agents: readonly AgentWithStatus[],
	categories: readonly CategoryWithUsage[],
	changeLog: readonly ChangeLogEntry[],
): ChangeLogNameMaps {
	const agentMap = new Map<string, string>();
	const categoryMap = new Map<string, string>();

	// Backfill names from historical snapshots first so deleted entities stay readable.
	for (const entry of changeLog) {
		for (const raw of [entry.beforeJson, entry.afterJson]) {
			const record = parseJsonRecord(raw);
			if (record === null) continue;
			if (entry.targetType === "category") {
				const cat = readRecord(record, "category") ?? record;
				const id = readString(cat, "id");
				const name = readString(cat, "name");
				if (id !== null && name !== null && !categoryMap.has(id)) {
					categoryMap.set(id, name);
				}
			} else if (
				entry.targetType === "agent" ||
				entry.targetType === "description"
			) {
				const agent = readRecord(record, "agent") ?? record;
				const id = readString(agent, "id") ?? readString(agent, "agentId");
				const name = readString(agent, "name");
				if (id !== null && name !== null && !agentMap.has(id)) {
					agentMap.set(id, name);
				}
			}
		}
	}

	for (const item of agents) {
		agentMap.set(item.agent.id, item.agent.name);
	}
	for (const item of categories) {
		categoryMap.set(item.category.id, item.category.name);
	}

	return { agents: agentMap, categories: categoryMap };
}

function formatRuleTarget(
	fromId: string,
	toId: string,
	categoryId: string,
	names: ChangeLogNameMaps,
): string {
	const fromName = names.agents.get(fromId) ?? fromId;
	const toName = names.agents.get(toId) ?? toId;
	const categoryName = names.categories.get(categoryId) ?? categoryId;
	return `${fromName} → ${toName} (${categoryName})`;
}

function formatActor(entry: ChangeLogEntry, names: ChangeLogNameMaps): string {
	const kind = entry.actorType === "owner" ? "所有者" : "管理者ボット";
	const actor =
		entry.actorType === "admin_bot"
			? (names.agents.get(entry.actorId) ?? entry.actorId)
			: entry.actorId;
	const approver =
		entry.approverId !== null ? `（承認: ${entry.approverId}）` : "";
	return `${kind}: ${actor}${approver}`;
}

export function describeChangeTarget(
	entry: ChangeLogEntry,
	names: ChangeLogNameMaps,
): string {
	switch (entry.targetType) {
		case "allow_rule": {
			const parts = entry.targetId.split(":");
			if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
				return formatRuleTarget(parts[0], parts[1], parts[2], names);
			}
			return entry.targetId;
		}
		case "category":
			return names.categories.get(entry.targetId) ?? entry.targetId;
		case "agent":
			return names.agents.get(entry.targetId) ?? entry.targetId;
		case "token": {
			const meta =
				parseJsonRecord(entry.afterJson) ?? parseJsonRecord(entry.beforeJson);
			const agentId = readString(meta, "agentId");
			const purpose = readString(meta, "purpose");
			if (agentId !== null) {
				const agentName = names.agents.get(agentId) ?? agentId;
				return purpose !== null ? `${agentName} (${purpose})` : agentName;
			}
			return entry.targetId;
		}
		case "admin_bot":
		case "description":
			return names.agents.get(entry.targetId) ?? entry.targetId;
	}
}

function describeAllowRuleSnapshot(
	record: Record<string, unknown>,
	raw: string,
	names: ChangeLogNameMaps,
): string {
	const fromId = readString(record, "fromAgentId");
	const toId = readString(record, "toAgentId");
	const categoryId = readString(record, "categoryId");
	if (fromId !== null && toId !== null && categoryId !== null) {
		return formatRuleTarget(fromId, toId, categoryId, names);
	}
	return raw;
}

function describeAgentSnapshot(
	targetId: string,
	record: Record<string, unknown>,
): string {
	const name = readString(record, "name") ?? targetId;
	const status = readString(record, "status");
	const limit = record.dailyQuestionLimit;
	const parts = [name];
	if (status !== null) parts.push(`状態=${status}`);
	if (typeof limit === "number") parts.push(`上限=${limit}/日`);
	return parts.join(" ");
}

function describeDescriptionSnapshot(
	record: Record<string, unknown>,
	raw: string,
): string {
	const desc = record.description;
	return typeof desc === "string" ? (desc.length > 0 ? desc : "（空）") : raw;
}

function describeRevertedSnapshot(
	entry: ChangeLogEntry,
	record: Record<string, unknown>,
	raw: string,
	names: ChangeLogNameMaps,
): string {
	switch (entry.targetType) {
		case "allow_rule":
			return describeAllowRuleSnapshot(record, raw, names);
		case "category":
			return readString(record, "name") ?? raw;
		case "agent":
			return describeAgentSnapshot(entry.targetId, record);
		case "description":
			return describeDescriptionSnapshot(record, raw);
		case "token":
		case "admin_bot":
			return raw;
	}
}

function describeSnapshot(
	entry: ChangeLogEntry,
	raw: string | null,
	names: ChangeLogNameMaps,
): string {
	if (raw === null) return "なし";
	const record = parseJsonRecord(raw);
	if (record === null) return raw;

	switch (entry.action) {
		case "allow_rule_granted":
		case "allow_rule_revoked":
			return describeAllowRuleSnapshot(record, raw, names);
		case "category_created":
			return readString(record, "name") ?? raw;
		case "category_deleted": {
			const cat = readRecord(record, "category");
			const name = readString(cat, "name") ?? entry.targetId;
			const count = readArrayLength(record, "allowRules");
			return count !== null ? `${name}（許可ルール ${count} 件）` : name;
		}
		case "agent_registered":
		case "agent_updated":
		case "agent_suspended":
		case "agent_resumed":
			return describeAgentSnapshot(entry.targetId, record);
		case "agent_deleted": {
			const agent = readRecord(record, "agent");
			const name = readString(agent, "name") ?? entry.targetId;
			const count = readArrayLength(record, "allowRules");
			return count !== null ? `${name}（許可ルール ${count} 件）` : name;
		}
		case "token_issued": {
			const purpose = readString(record, "purpose");
			return purpose !== null ? `${purpose} トークン` : raw;
		}
		case "token_revoked": {
			const count = readArrayLength(record, "tokens");
			return count !== null ? `有効トークン ${count} 件` : raw;
		}
		case "admin_bot_designated":
		case "admin_bot_cleared":
		case "admin_bot_switches_updated": {
			const agentId = readString(record, "agentId");
			if (agentId === null) {
				return "未指名";
			}
			const name = names.agents.get(agentId) ?? agentId;
			const extras: string[] = [];
			if (record.readBodies === true) {
				extras.push("本文閲覧=ON");
			}
			if (record.superadminUntil === -1) {
				extras.push("最高管理者=無期限");
			} else if (
				typeof record.superadminUntil === "number" &&
				Number.isSafeInteger(record.superadminUntil)
			) {
				extras.push(
					`最高管理者=有効（期限: ${new Date(record.superadminUntil).toISOString()}）`,
				);
			}
			return extras.length > 0 ? `${name}（${extras.join("・")}）` : name;
		}
		case "change_reverted":
			return describeRevertedSnapshot(entry, record, raw, names);
		case "description_approved":
		case "description_rejected":
			return describeDescriptionSnapshot(record, raw);
		case "webhook_configured":
		case "webhook_deleted": {
			const url = readString(record, "url");
			return url !== null ? `URL=${url}` : raw;
		}
	}
}

export function describeChangeBeforeAfter(
	entry: ChangeLogEntry,
	names: ChangeLogNameMaps,
): string {
	const before = describeSnapshot(entry, entry.beforeJson, names);
	const after =
		entry.afterJson === null && entry.beforeJson !== null
			? "削除"
			: describeSnapshot(entry, entry.afterJson, names);
	return `変更前: ${before} / 変更後: ${after}`;
}

function statusBadge(status: "active" | "suspended"): SafeHtml | false {
	return status === "suspended"
		? html` <span class="badge badge-danger">停止中</span>`
		: false;
}

function renderRuleGroupsSection(
	ruleGroups: readonly AllowRuleGroup[],
	csrfToken: string,
): SafeHtml {
	return html`
		<section class="card">
			<h2>許可ルール（一方向）</h2>
			<p class="muted">
				許可ルールは「送信元 → 宛先」の一方向です。A → B を許可しても、B → A は自動では許可されません。書かれていない組み合わせはすべて拒否されます。
			</p>
			${
				ruleGroups.length === 0
					? html`<p class="muted">許可ルールはまだありません。</p>`
					: html`
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>送信元 → 宛先</th>
										<th>許可カテゴリ（取り消し）</th>
									</tr>
								</thead>
								<tbody>
									${ruleGroups.map(
										(group) => html`
											<tr>
												<td>
													<strong>${group.fromAgentName}</strong>${statusBadge(group.fromAgentStatus)}
													→
													<strong>${group.toAgentName}</strong>${statusBadge(group.toAgentStatus)}
												</td>
												<td>
													<div class="actions">
														${group.categories.map(
															(cat) => html`
																<span class="actions">
																	<span class="badge">${cat.categoryName}</span>
																	<form method="POST" action="/admin/rules/revoke" class="inline-form">
																		${csrfInput(csrfToken)}
																		<input type="hidden" name="from_agent_id" value="${group.fromAgentId}">
																		<input type="hidden" name="to_agent_id" value="${group.toAgentId}">
																		<input type="hidden" name="category_id" value="${cat.categoryId}">
																		<button
																			type="submit"
																			class="btn btn-danger"
																			aria-label="${group.fromAgentName} から ${group.toAgentName} への「${cat.categoryName}」の許可を取り消す"
																		>
																			取り消す
																		</button>
																	</form>
																</span>
															`,
														)}
													</div>
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

function renderGrantRuleSection(data: RulesPageData): SafeHtml {
	const selectedFrom = data.formValues?.fromAgentId ?? "";
	const selectedTo = data.formValues?.toAgentId ?? "";
	const selectedCategory = data.formValues?.categoryId ?? "";

	return html`
		<section class="card">
			<h2>許可ルールを追加</h2>
			<div class="banner banner-info" role="note">
				注意（設計書 3.2 節）: 「その他」は初期状態ではどのエージェントの組み合わせにも許可されていません。意図しない情報開示を防ぐため、必要な場合だけ明示的に許可してください。
			</div>
			${
				data.agents.length < 2 || data.categories.length === 0
					? html`
						<p class="muted">
							許可ルールを作成するには、エージェントが2体以上とカテゴリが1件以上必要です。
						</p>
					`
					: false
			}
			<form method="POST" action="/admin/rules/grant">
				${csrfInput(data.csrfToken)}
				<div class="grid">
					<div class="field">
						<label for="grant-from-agent">送信元エージェント</label>
						<select id="grant-from-agent" name="from_agent_id" required>
							<option value="">選択してください</option>
							${data.agents.map(
								(item) => html`
									<option
										value="${item.agent.id}"${selectedFrom === item.agent.id ? rawHtml(" selected") : false}
									>
										${item.agent.name}${item.agent.status === "suspended" ? "（停止中）" : ""}
									</option>
								`,
							)}
						</select>
					</div>
					<div class="field">
						<label for="grant-to-agent">宛先エージェント</label>
						<select id="grant-to-agent" name="to_agent_id" required>
							<option value="">選択してください</option>
							${data.agents.map(
								(item) => html`
									<option
										value="${item.agent.id}"${selectedTo === item.agent.id ? rawHtml(" selected") : false}
									>
										${item.agent.name}${item.agent.status === "suspended" ? "（停止中）" : ""}
									</option>
								`,
							)}
						</select>
					</div>
					<div class="field">
						<label for="grant-category">カテゴリ</label>
						<select id="grant-category" name="category_id" required>
							<option value="">選択してください</option>
							${data.categories.map(
								(item) => html`
									<option
										value="${item.category.id}"${selectedCategory === item.category.id ? rawHtml(" selected") : false}
									>
										${item.category.name}
									</option>
								`,
							)}
						</select>
					</div>
				</div>
				<button type="submit" class="btn btn-primary">許可ルールを追加</button>
			</form>
		</section>
	`;
}

function renderCategoriesSection(data: RulesPageData): SafeHtml {
	return html`
		<section class="card">
			<h2>カテゴリ管理</h2>
			<form method="POST" action="/admin/categories">
				${csrfInput(data.csrfToken)}
				<div class="field">
					<label for="category-name">新しいカテゴリ名</label>
					<input
						id="category-name"
						type="text"
						name="name"
						value="${data.formValues?.categoryName ?? ""}"
						maxlength="64"
						required
					>
					<p class="muted">1〜64文字。カンマ（,）、改行、制御文字は使えません。</p>
				</div>
				<button type="submit" class="btn btn-primary">カテゴリを追加</button>
			</form>
			${
				data.categories.length === 0
					? html`<p class="muted">カテゴリはまだありません。</p>`
					: html`
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>カテゴリ名</th>
										<th>使用中の許可ルール数</th>
										<th>操作</th>
									</tr>
								</thead>
								<tbody>
									${data.categories.map(
										(item) => html`
											<tr>
												<td>${item.category.name}</td>
												<td>${item.allowRuleCount} 件</td>
												<td>
													<a
														class="btn btn-danger"
														href="/admin/categories/${encodeURIComponent(item.category.id)}/delete"
													>
														削除
													</a>
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

function renderChangeLogSection(
	changeLog: readonly ChangeLogEntry[],
	names: ChangeLogNameMaps,
): SafeHtml {
	return html`
		<section class="card">
			<h2>変更履歴（change_log）</h2>
			<p class="muted">最新の変更を先頭に表示します。</p>
			${
				changeLog.length === 0
					? html`<p class="muted">変更履歴はまだありません。</p>`
					: html`
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>日時</th>
										<th>操作者</th>
										<th>操作</th>
										<th>対象</th>
										<th>変更前後の要約</th>
									</tr>
								</thead>
								<tbody>
									${changeLog.map(
										(entry) => html`
											<tr>
												<td>${formatTimestamp(entry.occurredAt)}</td>
												<td>${formatActor(entry, names)}</td>
												<td>
													${CHANGE_ACTION_LABELS[entry.action]}
													${entry.revertedAt !== null ? html` <span class="badge">取消済</span>` : false}
												</td>
												<td>${describeChangeTarget(entry, names)}</td>
												<td>${describeChangeBeforeAfter(entry, names)}</td>
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

/** Renders the `/admin/rules` management screen. */
export function renderRulesPage(data: RulesPageData): SafeHtml {
	const names = collectEntityNames(
		data.agents,
		data.categories,
		data.changeLog,
	);
	return html`
		<div class="stack">
			<div>
				<h1>ルール・カテゴリ</h1>
				<p class="muted">
					エージェント間の質問許可ルールと質問カテゴリの追加・削除を行います。
				</p>
			</div>
			${renderRuleGroupsSection(data.ruleGroups, data.csrfToken)}
			${renderGrantRuleSection(data)}
			${renderCategoriesSection(data)}
			${renderChangeLogSection(data.changeLog, names)}
		</div>
	`;
}

/** Renders the 1-step confirmation screen for deleting a category. */
export function renderDeleteCategoryPage(
	data: DeleteCategoryConfirmData,
): SafeHtml {
	return html`
		<div class="stack">
			<div>
				<h1>カテゴリ削除の確認</h1>
				<p class="muted"><a href="/admin/rules">ルール・カテゴリへ戻る</a></p>
			</div>
			<section class="card">
				<h2>カテゴリ「${data.category.name}」を削除しますか？</h2>
				<div class="banner banner-warning" role="alert">
					このカテゴリを使っている許可ルール ${data.allowRuleCount} 件も同時に削除されます。
				</div>
				<p class="muted">
					このカテゴリを参照するメッセージも削除されます（監査ログは残ります）。
				</p>
				<form
					method="POST"
					action="/admin/categories/${encodeURIComponent(data.category.id)}/delete"
					class="actions"
				>
					${csrfInput(data.csrfToken)}
					<button type="submit" class="btn btn-danger">削除を確定する</button>
					<a class="btn" href="/admin/rules">キャンセル</a>
				</form>
			</section>
		</div>
	`;
}

/** Renders a 404 card when the target category does not exist. */
export function renderCategoryNotFoundPage(): SafeHtml {
	return html`
		<section class="card">
			<h1>カテゴリが見つかりません</h1>
			<p>指定されたカテゴリはすでに削除されたか、存在しません。</p>
			<p><a class="btn" href="/admin/rules">ルール・カテゴリへ戻る</a></p>
		</section>
	`;
}
