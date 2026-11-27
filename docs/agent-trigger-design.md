# エージェント起動トリガー設計書

paab（[設計書](design.md) の 2.3 節、2.5 節、6.1 節の第 4 段階）において、paab 側からパーソナル AI エージェントへ新着を伝えて動作を起動する仕組みを定義する。

この文書は 2026-11-27 の公開資料調査と Meta Muse 実環境での直接確認をまとめたもの。状態の凡例は [設計書](design.md) に揃え、次の 3 つを使う。

- **確定**。合意済み、または実環境とコードで確認済みの事実。
- **提案**。第 4 段階の実装前に合意する設計案。
- **未確認**。実機接続テストで確定させる項目。

## 1. 背景と課題

MCP の通常ツール呼び出しはクライアント（エージェント）起点のプル型である。エージェントが自律的に `check_inbox` を呼ばない限り、paab に届いた質問や回答は相手に渡らない。

対象製品（Meta Muse、Grok Bot、Cue）の外部起動入口を調査した結果、単一の公式プロトコルで全製品を直接起動する手段は 2026-11-27 時点で存在しない。さらに、第 4 段階の未マージドラフト（`feat/lead/webhook-notify` の `src/notify/sign.ts` と `src/notify/deliver.ts`）は次の 2 点で実製品と噛み合わない。

1. 署名方式が paab 独自生成鍵（`paab_whsec_`）と独自ヘッダー（`X-Paab-Timestamp`、`X-Paab-Signature`）に固定されている。Grok Bot が要求する Standard Webhooks 検証（Grok 側が発行する `whsec_` 鍵）や、Manus 側が指定する認証ヘッダーへ直接送れない。
2. `GET /unread` のポーリング例は VM 上でトークンをヘッダー送信する前提だが、Meta Muse の公式フック（ポーリングスクリプト）はシークレットやコネクタ資格情報を持てない仕様である。フックから低権限トークン付き HTTP GET が通るかは実機検証が要る。

この設計書は、受信箱方式（[設計書 2.1 節](design.md#21-受信箱方式確定)）を崩さずに 3 製品へ対応するための境界、認証方式、フォールバック、実装前検証ゲートを定める。

## 2. 対象製品の起動入口と制約（2026-11-27 調査）

| 製品 | 公式インバウンド HTTP Webhook | メール起動 | 定期実行と VM 内の仕組み | Custom MCP 認証と承認 | 根拠の区分 |
| --- | --- | --- | --- | --- | --- |
| Meta Muse | 不可（監視はポーリング方式と明記） | 条件付き可能。Muse Mail（`@muse.ai`）は検証済み送信元（`OWNER_AUTHORITY`）でバックグラウンド処理が走る。メールワーカーが Custom MCP を呼べるかは未確認 | 可能。ランタイム管理の cron（公式例 `5m`、`15m`、`1h`）とフック（最短 5 秒、既定 60 秒）がアプリ終了や VM 入れ替え後も常駐する。フックが `wake` を返すとワーカーエージェントが起動する。ただしフック自体はシークレットとコネクタ資格情報を持てない | `credentials.request_api_access` は単一 API キーのヘッダー配置（`Authorization: Bearer` 相当）に対応し、接続先ホストは登録制。`Background sync` の Allow・Deny 行はユーザー作成の cron とフックの対象外。cron ジョブにはコネクタ事前承認（preapproval）の枠組みがある | 2026-11-27 に Muse 実環境の公式ドキュメントと稼働ジョブ一覧で直接確認（確定）。Custom MCP の権限ツリーと無人承認、フックの外部 HTTP 制約は未確認 |
| Grok Bot（xAI） | 可能。`grok.com` の Automation と Routine に Webhook Trigger がある。発行 URL と `whsec_` 鍵を使い Standard Webhooks（HMAC-SHA256）で起動する | 対象外（公式 Webhook を優先） | 可能。定期ルーチンがある（最短 5 分間隔などプラン依存、毎時上限あり） | API と CLI では `Authorization` ヘッダー対応。`grok.com/connectors` UI は OAuth 前提の記述が多く、Bearer ヘッダーの可否は食い違いがある。Webhook 起動ルーチンからプライベート Custom MCP を呼ぶ際のスコープ制限報告がある | xAI 公式ドキュメントと公開記事（公開情報）。UI での Bearer 接続と Webhook 内 MCP 実行は未確認 |
| Cue（Manus 2.0） | 条件付き可能。Manus 2.0 Automations に URL と認証ヘッダーで HTTP POST 起動する Webhook Trigger がある | 可能。Cue エージェントごとに専用メールアドレスが付与される | 可能。クラウド環境と定期実行を持つ | Manus 2.0 は Custom MCP の Bearer トークンや API キー認証に対応する | Manus 2.0 公式ドキュメントと公開記事（公開情報）。Automations Webhook が Cue 個人エージェントの記憶と MCP 接続を引き継ぐかは未確認 |

Meta Muse の補足として、公式ハードウェア向け SDK（`facebookincubator/muse-gadget-sdk`）は Muse からデバイスへの呼び出し専用である。外部サーバーからサイドチャットへ投稿する公式 API は確認できなかった。コミュニティ製 OSS の `Code-Hex/MuseKnock` は存在するが、paab 本体の前提には置かない。

## 3. 代替案の比較と採用方針

| 案 | 仕組み | 利点 | 欠点 | 判断 |
| --- | --- | --- | --- | --- |
| 案 A. 本文なし HTTP Webhook と外部アダプタ | 新着時に登録 URL へ固定 JSON `{"event":"inbox_wake"}` を送る。認証は Standard Webhooks、認証ヘッダー、独自 HMAC から選ぶ。Webhook 非対応製品には別 Worker 等の外部アダプタを宛先として登録する | Workers Free プランのまま動く。paab 本体が各製品のアカウント資格情報や有料メール基盤を抱えない。[設計書 2.3 節](design.md#23-規則) と整合する | Webhook 非対応製品を即時起動したい場合、外部アダプタの運用が 1 つ増える | **採用（プッシュ対応製品の主軸、提案）** |
| 案 B. 未読件数窓口（`GET /unread`）と定期確認・フック | `unread_count` 専用トークンで未読件数だけを返す HTTP 窓口を設ける。エージェント側のフックまたは定期 cron で確認し、新着時だけ `check_inbox` を呼ぶ | 外部起動入口がない製品でも動く。案 A の通知失敗時の安全網になる。[設計書 2.5 節](design.md#25-vm上の定期確認スクリプト確定) に合致する | 数十秒から数分の遅延がある。cron から直接 MCP を叩く場合は空振りでも AI 利用枠を使う | **採用（Webhook 非対応製品の主軸およびフォールバック、確定）** |
| 案 C. paab 本体からメール送信 | Worker から Muse Mail（`@muse.ai`）や Cue 専用アドレスへ通知メールを送る | Muse と Cue の公式メール入口を直接使える | [設計書 2.1 節](design.md#21-受信箱方式確定)（「実際のメールや外部の通知サービスは使わない」）に反する。Cloudflare Email Service の `send_email` で任意宛先へ送るには Workers Paid プランが必要（Free プランは検証済み宛先限定であり、Muse Mail は確認リンクを自動除去するため検証自体が通らない可能性が高い）。独自ドメインと SPF・DKIM 運用が増える | **不採用**（必要なら案 A の外部アダプタとして paab の外に分離する） |
| 案 D. paab 本体に製品別 SDK を内蔵 | Muse 向けデバイス認証や各社 API クライアントを paab の Worker へ組み込む | デプロイする Worker が 1 つで済む | paab の原則（中継専用、他サービスのユーザー資格情報を持たない）が崩れる。各社の仕様変更で paab 本体が壊れやすくなる | **不採用** |
| 案 E. MCP Events（SEP-3415）に一本化 | MCP のイベント購読仕様（`events/subscribe`、`subscriptions/listen`）を実装する | クライアント対応が揃えば登録と署名を MCP 標準に統一できる | 2026-11 時点で SEP-3415 は beta 段階であり、Muse・Grok Bot・Cue のネイティブ対応が確認できない | **後回し**（[設計書 7 節](design.md#7-後回し) と同じく将来拡張に留める） |

**採用方針（提案）**。paab 本体は「案 A（本文なし HTTP Webhook）」と「案 B（`GET /unread` と定期実行・フック）」の 2 系統だけを提供する。製品固有の変換（メール転送や非公式チャット投稿ブリッジ）はすべて paab の外部アダプタに分離し、paab 本体の Workers Free 運用と無資格情報原則を守る。

## 4. 詳細設計

### 4.1 通知の不変条件と発火契機（確定・提案）

paab の受信箱が正本であり、トリガーは通知の欠落を許容する高速化手段である。すべての通知経路は次の不変条件を満たす。

- ペイロードには質問文、回答文、送信元名、カテゴリを含めない。送信ボディは固定 JSON `{"event":"inbox_wake"}` のみとする。
- 宛先エージェントの状態が `suspended` のときは送信しない。保留中の配達レコードも破棄する。
- 同一エージェントへの複数新着は保留中の 1 件に集約（coalesce）し、連続発火を防ぐ。
- 送信失敗時は上限 3 回（遅延 0 秒、60 秒、300 秒）まで再試行し、失敗確定後は `abandoned` として監査ログへ記録する。メッセージ本体は D1 の受信箱にそのまま残る。
- SSRF 防御として HTTPS のみ許可（ローカル試験時のみ設定フラグで例外許可）、プライベート IP 拒否、`redirect: "manual"` によるリダイレクト拒否、5 秒タイムアウトを適用する。

発火契機は、D1 の `messages` テーブルに配達可能な行が追加される 4 箇所に限定する。

| 契機 | 対象ファイル（現行 `main`） | 通知先 | 送信タイミング | 理由 |
| --- | --- | --- | --- | --- |
| `ask` が許可された | `src/inbox/ask.ts`（`submitQuestion`） | 宛先エージェント | 即時（`ctx.waitUntil`） | 宛先へ質問到着を速やかに伝える |
| `ask` がルール等で拒否された | `src/inbox/ask.ts`（`recordBlockedQuestion`） | 質問元エージェント | 遅延（60 秒後、cron または次回処理） | [設計書 3.4 節](design.md#34-拒否の伝え方確定) に従い、ブリッジ拒否と回答側拒否を応答時刻の差で見分けさせない |
| `answer` で回答または拒否された | `src/inbox/answer.ts`（`answerQuestion`） | 質問元エージェント | 即時（`ctx.waitUntil`） | 質問元へ結果到着を伝える |
| 定期実行で質問が期限切れになった | `src/inbox/maintenance.ts`（`expireQuestions`） | 質問元エージェント | 定期実行内 | 期限切れの `rejection` が質問元の受信箱へ追加されるため |

Worker の `fetch` ハンドラ（`src/index.ts`）は `ExecutionContext` を `handleMcpRequest` へ渡し、即時通知の初回送信を `ctx.waitUntil` で実行する。MCP レスポンス自体は Webhook 完了を待たずに返す。

### 4.2 Webhook の認証と署名方式（提案）

既存ドラフト（`feat/lead/webhook-notify`）の `agent_webhooks` は paab 独自生成鍵（`paab_whsec_`）と独自ヘッダーのみを想定していた。Grok Bot と Manus・Cue へ直接接続できるよう、エージェントごとの Webhook 設定に `auth_mode` を導入する。登録・変更・削除は管理画面（`/admin/agents`）から人間だけが行う（[設計書 5.2 節](design.md#52-人間だけができること確定)）。

| `auth_mode` | 想定する受け手 | 鍵・トークンの発行元 | 送信ヘッダーと署名仕様 |
| --- | --- | --- | --- |
| `standard_webhooks` | Grok Bot（xAI）、Standard Webhooks 準拠レシーバ | 受け手側が発行する `whsec_<base64>` 鍵を利用者が登録 | `Content-Type: application/json`、`webhook-id: <delivery UUID>`、`webhook-timestamp: <UNIX秒>`、`webhook-signature: v1,<base64>`。署名は `whsec_` を除いて Base64 デコードした鍵で `${webhook-id}.${webhook-timestamp}.${raw_body}` の HMAC-SHA256 を計算する |
| `bearer_header` | Manus・Cue Webhook Trigger、Bearer 認証の外部アダプタ | 受け手側が発行するトークンを利用者が登録 | `Content-Type: application/json`、`Authorization: Bearer <secret>` |
| `custom_header` | 任意ヘッダーを要求する Webhook Trigger や外部アダプタ | 受け手側が指定するヘッダー名と値を利用者が登録 | `Content-Type: application/json`、`<header_name>: <secret>`。ヘッダー名は英数字とハイフンのみ許可し、改行・制御文字・禁止ヘッダー（`Host`、`Content-Length`、`Content-Type`、`Connection`、`Transfer-Encoding` 等）を拒否する |
| `paab_hmac` | 自前レシーバ（既存ドラフト互換） | paab が `paab_whsec_` 鍵を自動生成 | `Content-Type: application/json`、`X-Paab-Timestamp: <UNIX秒>`、`X-Paab-Signature: sha256=<hex>`。署名は鍵の UTF-8 バイト列で `${timestamp}.${raw_body}` の HMAC-SHA256 を計算する |

`agent_webhooks` テーブルの拡張案を次に示す（既存ドラフト `migrations/0007_webhooks.sql` への追加列を含む）。

```sql
CREATE TABLE agent_webhooks (
	agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	auth_mode TEXT NOT NULL CHECK (
		auth_mode IN ('standard_webhooks', 'bearer_header', 'custom_header', 'paab_hmac')
	),
	header_name TEXT,
	secret TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	CHECK ((auth_mode = 'custom_header') = (header_name IS NOT NULL))
) STRICT;
```

秘密値の保護規則は次の 3 点とする。

1. `secret` は `paab_hmac` の初回生成時・ローテーション時に一度だけ管理画面へ表示する。外部発行鍵（`standard_webhooks`、`bearer_header`、`custom_header`）は登録後に再表示しない。
2. `standard_webhooks` 登録時は `whsec_` 接頭辞と後続 Base64 の妥当性（デコード長 16 バイト以上）を境界で検証する。
3. 送信失敗時の `last_error` や監査ログに `secret` や送信ヘッダー値を含めない。

### 4.3 未読件数窓口（`GET /unread`）とポーリング・フック運用（確定・提案）

Webhook を直接受けられない製品、および Webhook 失敗時のフォールバックとして、非 MCP の HTTP 窓口 `GET /unread` を提供する。

- 認証は `Authorization: Bearer <unread_count_token>` ヘッダーのみを受け付ける（[設計書 3.5 節](design.md#35-本人確認確定)）。`tokens.purpose = 'unread_count'` のトークンだけを許可する（`migrations/0001_initial_schema.sql` と `src/types.ts` に予約済み）。
- Cloudflare Access の対象外とし、エージェント側ランタイムから直接叩けるようにする。
- レスポンスは HTTP 200、`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`、ボディは `{"unread": <件数>}`。`countUnread`（`src/inbox/fetch.ts`）を再利用し、`received_at` は更新しない。
- `suspended` 状態のエージェントはトークン検証後に HTTP 403 を返す。認証失敗時は他の窓口と同じく監査ログに `auth_failed` を残し、空の HTTP 401 を返す。
- URL クエリ（`?token=...`）でのトークン送信はアクセスログやプロキシログに平文が残るため採用しない。

Meta Muse での運用は、フックの「シークレット・コネクタ資格情報不可」制約を踏まえて次の 2 段階に分岐させる。

1. **フック経由の軽量ポーリング（第 1 候補）**。実機検証で Muse フックから paab ホストへの HTTP GET と `Authorization` ヘッダー送信、および `wake` 後のワーカーからの Custom MCP 呼び出しが通る場合、既定 60 秒間隔の Muse フックで `GET /unread` を監視する。件数が 1 以上なら `wake` を返し、起きたワーカーが Custom MCP の `check_inbox` と `answer` を実行する。
2. **定期 cron による直接確認（第 2 候補）**。フックから `GET /unread` への認証付きアクセス、またはフック起動ワーカーからの Custom MCP 呼び出しが制約で通らない場合、Muse の定期 cron（5 分または 15 分間隔）のエージェントジョブから Custom MCP の `check_inbox` を直接呼ぶ。

### 4.4 製品別の推奨接続パターン

| 製品 | 主手段 | フォールバック | 備考 |
| --- | --- | --- | --- |
| Grok Bot（xAI） | Webhook（`auth_mode = 'standard_webhooks'`） | 定期ルーチンで `check_inbox` | Webhook 起動ルーチン内で Custom MCP が動くことをゲート 3 で事前確認する |
| Cue（Manus 2.0） | Manus Automations Webhook（`bearer_header` または `custom_header`） | 定期ルーチン、または paab の Webhook を受けて Cue 専用アドレスへメール転送する外部アダプタ | Automations Webhook が Cue 個人エージェントの記憶と MCP 接続を共有するかをゲート 4 で確認する |
| Meta Muse | Muse フック（60 秒間隔で `GET /unread`）または定期 cron（`check_inbox`） | なし（定期確認自体が受信箱の取りこぼしを防ぐ） | 即時起動が必須になった場合のみ、paab の Webhook を受ける外部アダプタを別 Worker として外に置く |

## 5. 第 4 段階実装前の実機検証ゲート

新規コードを増やす前に、現行 `main` にすでにある `GET /health`（`src/index.ts`）と `/mcp`（`src/mcp/tools.ts`）だけで次の 4 ゲートを実機確認する。

1. **ゲート 1（Muse の接続と権限ツリー）**。現行 `main` を [導入手順](setup.md) どおりにデプロイし、Muse へ `credentials.request_api_access`（単一 API キーの `Authorization: Bearer` ヘッダー）で `/mcp` を接続する。設定画面のコネクタ権限ツリーに `check_inbox` と `answer` が並び、事前許可または Allow を選べるか確認する。
2. **ゲート 2（Muse の無人実行とフック）**。(a) 2 分後に 1 回だけ `check_inbox` を呼ぶ cron ジョブを作り、アプリを閉じた状態で人間承認なしに完走するか確かめる。(b) 既存の `GET /health` へダミーの `Authorization` ヘッダー付き HTTP GET を送る 1 回限りのフックを作り、外部 GET が通ること、および `wake` で起動したワーカーが `check_inbox` を呼べることを確かめる。
3. **ゲート 3（Grok Bot の MCP 認証と Webhook 内実行）**。`grok.com/connectors` で paab の `/mcp` へ Bearer ヘッダー認証で接続できるか確かめる。接続できた場合、Webhook Trigger（`whsec_`）へ手動で Standard Webhooks 署名付き POST を送り、起動したルーチンが承認停止やスコープ制限に掛からず `check_inbox` と `answer` を呼べるか確認する。
4. **ゲート 4（Cue の Webhook 文脈共有）**。Manus 2.0 Automations の Webhook Trigger を発火させ、起動した実行が Cue アプリ側の個人エージェントの記憶と Custom MCP 接続を使えるか、別タスクになるかを確認する。

ゲート結果に応じた実装分岐は次のとおり。

| ゲート結果 | 実装への反映 |
| --- | --- |
| ゲート 1・2 ともに通過（フック HTTP と無人 MCP の両方が成功） | `GET /unread` と Muse フック向けサンプルスクリプトを同梱する |
| ゲート 2 の cron のみ通過（フックの外部 HTTP または `wake` 後の MCP が不可） | Muse は定期 cron の `check_inbox` 運用とし、Muse フック用サンプルは作らない |
| ゲート 1・2 でバックグラウンド MCP が毎回承認で停止 | Muse での完全無人応答は対象外とし、フックまたは cron は「未読あり」を利用者へ通知する用途に限定する |
| ゲート 3 で Grok Bot の `grok.com/connectors` が OAuth 必須と判明 | Grok Bot 対応の前に OAuth 認証（[設計書 7 節](design.md#7-後回し)）を前倒しするか、対象から外す判断を行う |
| ゲート 3 で Webhook 内からのプライベート Custom MCP が不可と判明 | Grok Bot は定期ルーチンまたは外部リレー経由へ切り替える |
| ゲート 4 で Automations Webhook が Cue の文脈と分離していると判明 | Cue は定期ルーチン、または paab の Webhook を受けて Cue 専用メールへ転送する外部アダプタで接続する |

## 6. 既存設計書および未マージ第 4 段階ドラフトとの差分

### 6.1 `docs/design.md` への反映

この文書の作成に合わせて、[設計書](design.md) の 2.3 節、2.5 節、6.2 節、8 節へ次の更新を入れた。

- 2.3 節に、呼び出し先 URL の署名・認証方式の詳細としてこの文書への参照を追加。
- 2.5 節に、Muse のフック制約とこの文書への参照を追記。
- 6.2 節に Cue（Manus 2.0）を追加し、Meta Muse と Grok Bot の調査結果を 2026-11-27 時点の事実へ更新。
- 8 節の未確認事項について、Muse で確認済みの事実と、ゲート 1 から 4 で実機確認する項目を分離。

### 6.2 未マージの第 4 段階ブランチに対する追加工事

既存の未マージブランチ（`feat/lead/unread-count-endpoint`、`feat/lead/webhook-notify`、`feat/lead/polling-script-example`）を `main` へ取り込む際、または後続 PR で次の変更を行う。

1. `feat/lead/webhook-notify` の `migrations/0007_webhooks.sql`、`src/notify/sign.ts`、`src/notify/deliver.ts`、`src/admin/webhooks.ts`、`/admin/agents` UI に `auth_mode`（`standard_webhooks`、`bearer_header`、`custom_header`、`paab_hmac`）と利用者入力シークレットを追加する。
2. `feat/lead/unread-count-endpoint` の `GET /unread` は 4.3 節の仕様と一致しており、そのまま採用できる。
3. `feat/lead/polling-script-example` のサンプル群には、ゲート 2 の結果が確定したあとに Muse 向け設定手順またはフックサンプルを追記する。

## 7. 出典と確認記録

- 2026-11-27 Meta Muse 実環境での直接確認（Muse 公式ドキュメントの connectors、scheduling、Muse Mail、Gadget と稼働中のフック・cron 一覧）
- [Meta Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk)
- [Code-Hex/MuseKnock（コミュニティ製 Cloudflare Workers ブリッジ事例）](https://github.com/Code-Hex/MuseKnock)
- xAI Grok Webhook Triggers と Custom MCP の公式ドキュメント（`x.ai`）
- Manus 2.0 Automations と Cue の公式ドキュメント（`manus.im`、`manus.ai`）
- [Standard Webhooks 仕様](https://www.standardwebhooks.com/)
- [MCP Events 設計案（SEP-3415、experimental-ext-triggers-events）](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)
- [Cloudflare Email Service の send_email バインディング仕様](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
