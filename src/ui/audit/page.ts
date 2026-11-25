import {
	type AuditLogFilter,
	type AuditLogView,
	queryAuditLog,
} from "../../audit";
import { AUDIT_OUTCOMES, type AuditOutcome } from "../../types";
import { html, rawHtml, type SafeHtml } from "../html";
import { formatTimestamp } from "../layout";
import {
	buildAuditHref,
	DEFAULT_UI_AUDIT_LIMIT,
	MAX_UI_AUDIT_LIMIT,
	type ParsedAuditQuery,
	type RawAuditFormValues,
} from "./filter";

export interface AuditPageData {
	readonly entries: readonly AuditLogView[];
	readonly hasNewer: boolean;
	readonly hasOlder: boolean;
	readonly prevAfterId: number | null;
	readonly nextBeforeId: number | null;
	readonly bodyRecordingEnabled: boolean;
	readonly includeBody: boolean;
}

const OUTCOME_BADGE_CLASSES: Record<AuditOutcome, string> = {
	ok: "badge-ok",
	denied: "badge-danger",
	expired: "badge-dev",
};

/**
 * Fetches one page of audit log entries with lookahead pagination in either
 * direction (`before_id` descending or `after_id` ascending reversed).
 */
export async function fetchAuditPage(
	db: D1Database,
	query: ParsedAuditQuery,
	bodyRecordingEnabled: boolean,
): Promise<AuditPageData> {
	const includeBody = query.showBodyRequested && bodyRecordingEnabled;
	const baseFilter: AuditLogFilter = {
		occurredFrom: query.occurredFrom,
		occurredBefore: query.occurredBefore,
		fromAgentName: query.fromAgentName,
		toAgentName: query.toAgentName,
		categoryName: query.categoryName,
		outcome: query.outcome,
		messageId: query.messageId,
		excludeEventTypes: query.showAuthFailed ? undefined : ["auth_failed"],
		includeBody,
	};

	const pageSize = query.limit;
	const lookaheadLimit = pageSize + 1;

	if (query.cursor.kind === "after") {
		const rows = await queryAuditLog(db, {
			...baseFilter,
			afterId: query.cursor.id,
			order: "asc",
			limit: lookaheadLimit,
		});
		const hasNewer = rows.length > pageSize;
		const entries = rows.slice(0, pageSize).reverse();
		const first = entries[0];
		const last = entries[entries.length - 1];
		let hasOlder = false;
		if (last !== undefined) {
			const olderProbe = await queryAuditLog(db, {
				...baseFilter,
				beforeId: last.id,
				order: "desc",
				limit: 1,
			});
			hasOlder = olderProbe.length > 0;
		}
		return {
			entries,
			hasNewer,
			hasOlder,
			prevAfterId: hasNewer && first !== undefined ? first.id : null,
			nextBeforeId: hasOlder && last !== undefined ? last.id : null,
			bodyRecordingEnabled,
			includeBody,
		};
	}

	const rows = await queryAuditLog(db, {
		...baseFilter,
		beforeId: query.cursor.kind === "before" ? query.cursor.id : undefined,
		order: "desc",
		limit: lookaheadLimit,
	});
	const hasOlder = rows.length > pageSize;
	const entries = rows.slice(0, pageSize);
	const first = entries[0];
	const last = entries[entries.length - 1];
	let hasNewer = false;
	if (query.cursor.kind === "before" && first !== undefined) {
		const newerProbe = await queryAuditLog(db, {
			...baseFilter,
			afterId: first.id,
			order: "asc",
			limit: 1,
		});
		hasNewer = newerProbe.length > 0;
	}
	return {
		entries,
		hasNewer,
		hasOlder,
		prevAfterId: hasNewer && first !== undefined ? first.id : null,
		nextBeforeId: hasOlder && last !== undefined ? last.id : null,
		bodyRecordingEnabled,
		includeBody,
	};
}

function renderEntityCell(name: string | null, id: string | null): SafeHtml {
	if (name !== null) {
		return html`${name}`;
	}
	if (id !== null) {
		return html`<code>${id}</code> <span class="muted">(削除済み)</span>`;
	}
	return html`-`;
}

function renderMessageIdCell(
	messageId: string | null,
	showAuthFailed: boolean,
	showBody: boolean,
): SafeHtml {
	if (messageId === null) {
		return html`-`;
	}
	const href = buildAuditHref({
		messageId,
		showAuthFailed,
		showBody,
	});
	return html`<a href="${href}"><code>${messageId}</code></a>`;
}

function renderFilterForm(
	raw: RawAuditFormValues,
	bodyRecordingEnabled: boolean,
): SafeHtml {
	return html`
		<section class="card">
			<h2>絞り込み</h2>
			<form method="GET" action="/admin/audit">
				<div class="grid">
					<div class="field">
						<label for="audit-since">開始日時（since・以上）</label>
						<input type="text" id="audit-since" name="since" value="${raw.since}" placeholder="2026-11-16 または 2026-11-16T09:00+09:00">
					</div>
					<div class="field">
						<label for="audit-before">終了日時（before・未満）</label>
						<input type="text" id="audit-before" name="before" value="${raw.before}" placeholder="2026-11-17 または 2026-11-17T00:00Z">
					</div>
					<div class="field">
						<label for="audit-from">送信元エージェント（from）</label>
						<input type="text" id="audit-from" name="from" value="${raw.from}" placeholder="例: muse">
					</div>
					<div class="field">
						<label for="audit-to">宛先エージェント（to）</label>
						<input type="text" id="audit-to" name="to" value="${raw.to}" placeholder="例: grok">
					</div>
					<div class="field">
						<label for="audit-category">カテゴリ（category）</label>
						<input type="text" id="audit-category" name="category" value="${raw.category}" placeholder="例: 予定">
					</div>
					<div class="field">
						<label for="audit-outcome">結果（outcome）</label>
						<select id="audit-outcome" name="outcome">
							<option value="">すべて</option>
							${AUDIT_OUTCOMES.map(
								(option) =>
									html`<option value="${option}"${raw.outcome === option ? rawHtml(" selected") : false}>${option}</option>`,
							)}
						</select>
					</div>
					<div class="field">
						<label for="audit-message-id">質問ID（message_id）</label>
						<input type="text" id="audit-message-id" name="message_id" value="${raw.messageId}" placeholder="メッセージID">
					</div>
					<div class="field">
						<label for="audit-limit">表示件数（limit）</label>
						<input type="number" id="audit-limit" name="limit" min="1" max="${MAX_UI_AUDIT_LIMIT}" value="${raw.limit}" placeholder="${DEFAULT_UI_AUDIT_LIMIT}">
					</div>
				</div>
				<div class="stack">
					<div class="actions">
						<label>
							<input type="checkbox" name="show_auth_failed" value="1"${raw.showAuthFailed ? rawHtml(" checked") : false}>
							認証失敗（auth_failed）を含める
						</label>
						<label>
							<input type="checkbox" name="show_body" value="1"${raw.showBody && bodyRecordingEnabled ? rawHtml(" checked") : false}${!bodyRecordingEnabled ? rawHtml(" disabled") : false}>
							本文を表示する
						</label>
						${
							!bodyRecordingEnabled
								? html`<span class="muted">（本文記録は無効です: AUDIT_RECORD_BODIES が有効かつ保持日数が正の整数のときのみ表示可能）</span>`
								: false
						}
					</div>
					<div class="actions">
						<button type="submit" class="btn btn-primary">絞り込む</button>
						<a class="btn" href="/admin/audit">条件をクリア</a>
					</div>
				</div>
			</form>
		</section>
	`;
}

function renderPagination(
	query: ParsedAuditQuery,
	page: AuditPageData,
): SafeHtml {
	const shared = {
		since: query.raw.since,
		before: query.raw.before,
		from: query.raw.from,
		to: query.raw.to,
		category: query.raw.category,
		outcome: query.raw.outcome,
		messageId: query.raw.messageId,
		limit: query.limit,
		showAuthFailed: query.showAuthFailed,
		showBody: query.showBodyRequested && page.bodyRecordingEnabled,
	};

	const prevHref =
		page.hasNewer && page.prevAfterId !== null
			? buildAuditHref({
					...shared,
					cursor: { kind: "after", id: page.prevAfterId },
				})
			: null;
	const nextHref =
		page.hasOlder && page.nextBeforeId !== null
			? buildAuditHref({
					...shared,
					cursor: { kind: "before", id: page.nextBeforeId },
				})
			: null;
	const latestHref =
		query.cursor.kind !== "latest"
			? buildAuditHref({
					...shared,
					cursor: { kind: "latest" },
				})
			: null;

	return html`
		<div class="actions">
			${prevHref !== null ? html`<a class="btn" rel="prev" href="${prevHref}">前のページ（新しい記録）</a>` : false}
			${latestHref !== null && prevHref === null ? html`<a class="btn" href="${latestHref}">最新の記録へ</a>` : false}
			${nextHref !== null ? html`<a class="btn" rel="next" href="${nextHref}">次のページ（古い記録）</a>` : false}
		</div>
	`;
}

export function renderAuditPage(options: {
	readonly raw: RawAuditFormValues;
	readonly query?: ParsedAuditQuery;
	readonly page?: AuditPageData;
	readonly bodyRecordingEnabled: boolean;
}): SafeHtml {
	const { raw, query, page, bodyRecordingEnabled } = options;

	const bodyDisabledNotice =
		raw.showBody && !bodyRecordingEnabled
			? html`
				<div class="banner banner-info" role="status">
					監査ログへの本文記録が無効（<code>AUDIT_RECORD_BODIES</code> オフまたは保持期間未設定）のため、本文は表示されません。
				</div>
			`
			: false;

	let resultsSection: SafeHtml | false = false;
	if (query !== undefined && page !== undefined) {
		const pagination = renderPagination(query, page);
		const showBodyInLinks =
			query.showBodyRequested && page.bodyRecordingEnabled;

		resultsSection = html`
			<section class="card stack">
				<div class="actions">
					<span class="muted">
						表示件数: ${page.entries.length} 件（上限 ${query.limit} 件）
						${query.showAuthFailed ? "" : "・auth_failed は非表示"}
					</span>
					${pagination}
				</div>
				${
					page.entries.length === 0
						? html`<p class="muted">条件に一致する監査ログはありません。</p>`
						: html`
							<div class="table-wrap">
								<table>
									<thead>
										<tr>
											<th>ID</th>
											<th>日時</th>
											<th>種別</th>
											<th>送信元</th>
											<th>宛先</th>
											<th>カテゴリ</th>
											<th>結果</th>
											<th>理由</th>
											<th>質問ID</th>
											${page.includeBody ? html`<th>本文</th>` : false}
										</tr>
									</thead>
									<tbody>
										${page.entries.map(
											(entry) => html`
												<tr>
													<td>${entry.id}</td>
													<td>${formatTimestamp(entry.occurredAt)}</td>
													<td><code>${entry.eventType}</code></td>
													<td>${renderEntityCell(entry.fromAgentName, entry.fromAgentId)}</td>
													<td>${renderEntityCell(entry.toAgentName, entry.toAgentId)}</td>
													<td>${renderEntityCell(entry.categoryName, entry.categoryId)}</td>
													<td><span class="badge ${OUTCOME_BADGE_CLASSES[entry.outcome]}">${entry.outcome}</span></td>
													<td>${entry.reasonCode !== null ? html`<code>${entry.reasonCode}</code>` : "-"}</td>
													<td>${renderMessageIdCell(entry.messageId, query.showAuthFailed, showBodyInLinks)}</td>
													${page.includeBody ? html`<td>${entry.body ?? "-"}</td>` : false}
												</tr>
											`,
										)}
									</tbody>
								</table>
							</div>
							${pagination}
						`
				}
			</section>
		`;
	}

	return html`
		<div class="stack">
			<div>
				<h1>監査ログ</h1>
				<p class="muted">質問・配信・回答・拒否・期限切れ・認証失敗の記録を絞り込んで確認します。</p>
			</div>
			${bodyDisabledNotice}
			${renderFilterForm(raw, bodyRecordingEnabled)}
			${resultsSection}
		</div>
	`;
}
