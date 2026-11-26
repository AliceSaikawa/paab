# paab の導入と管理コマンド

第1段階のpaabには管理画面がない。エージェントの登録、カテゴリと許可ルールの設定、トークンの発行、監査ログの確認は、この文書のコマンドで行う。

どのコマンドも、ローカルのD1（`wrangler dev` が使うもの）と本番のD1のどちらに対して実行するかを、`--local` か `--remote` で必ず指定する。指定がないとエラーで止まる。

## 準備

1. Node `>=22.12.0` と npm `>=11.12.1` を用意し、依存を入れる。

   ```sh
   npm ci
   ```

   npm 12 では `esbuild` と `workerd` の postinstall が `allowScripts` の対象外として止められ、警告が出ることがある。警告が出ても `npm run check` は通る。管理コマンド（`npm run seed` など）が esbuild を見付けられないときは `npm install-scripts approve esbuild workerd` を実行するか、`package.json` の `allowScripts` に両方を登録する（`approve` を実行すると共有の `package.json` の `allowScripts` に版付きで書き込まれるため、意図せずコミットしないよう注意し、依存を更新したときは再登録する）。

2. 本番のD1に対して実行する場合は、Cloudflareにログインし、D1データベースを作る。

   ```sh
   npx wrangler login
   npx wrangler d1 create paab-db
   ```

   `wrangler.jsonc` を `wrangler.local.jsonc` に写し、表示された `database_id` を写した方の `d1_databases` に書く。リポジトリの `wrangler.jsonc` の値（`00000000-...`）はダミーである。

   ```sh
   cp wrangler.jsonc wrangler.local.jsonc
   ```

   `wrangler.local.jsonc` は git の管理外である。作業ツリーの `wrangler.jsonc` を直接書き換えると、更新の取り込みで衝突し、誤ってコミットするおそれもある。本番へのデプロイと本番 D1 へのコマンドには必ず `wrangler.local.jsonc` を使う（「本番へのデプロイ」と「新しい版への更新」を参照）。

3. マイグレーションを適用する。

   ```sh
   npx wrangler d1 migrations apply DB --local                              # ローカル
   npx wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc  # 本番
   ```

## 1. 初期値ファイルを作る

見本を写して `paab.seed.json` を作り、自分の環境に合わせて書き換える。`paab.seed.json` はgitの管理外である。

```sh
cp paab.seed.example.json paab.seed.json
```

ファイルの形は次のとおり。

```json
{
	"ownerId": "me",
	"agents": [
		{ "name": "muse", "description": "日々の予定と連絡先を管理しているエージェント。", "dailyQuestionLimit": 20 },
		{ "name": "grok", "description": "仕事の調べものと好みの記録を担当するエージェント。", "dailyQuestionLimit": 20 }
	],
	"categories": ["予定", "連絡先", "好み・習慣", "仕事", "健康", "金融", "位置情報", "その他"],
	"allowRules": [
		{ "from": "muse", "to": "grok", "categories": ["仕事", "好み・習慣"] },
		{ "from": "grok", "to": "muse", "categories": ["予定", "連絡先"] }
	]
}
```

| 項目 | 内容 |
| --- | --- |
| `ownerId` | 所有者ID。全エージェントに同じ値が入る |
| `agents[].name` | エージェント名。質問の宛先やトークン発行で使う。重複できない |
| `agents[].description` | 他のエージェントに見せる説明文 |
| `agents[].dailyQuestionLimit` | 1日（UTC）あたりの質問数上限。0以上の整数 |
| `categories` | カテゴリ名の一覧。重複できない |
| `allowRules[]` | `from` のエージェントが `to` のエージェントに `categories` について質問することを許可する。書かれていない組み合わせはすべて拒否される |

名前と説明文には、ツールの返り値の行の構造を壊さないための制限がある（`src/policy/naming.ts`）。名前は NFC に正規化して前後の空白を除いたうえで 1〜64 文字。改行・制御文字・方向制御や段落区切りなどの書式文字・カンマ（,）は使えない（カンマは `list_agents` のカテゴリの区切りと紛らわしい）。説明文は NFC に正規化して 1000 文字まで。改行とタブ以外の制御文字は使えない。NFC 正規化の違いだけの名前は同じ名前として扱われ、大文字・小文字や全角・半角の違いは区別される。

許可ルールは向きごとに書く。`muse` から `grok` への許可は、`grok` から `muse` への許可を含まない。見本では「その他」をどの組み合わせにも許可していない（設計書 3.2 節）。

## 2. 初期値を投入する

```sh
npm run seed -- --local     # ローカル
npm run seed -- --remote    # 本番
```

別のファイルを使うときは `--file <パス>` を付ける。

- 投入の前に、ファイル全体を検証する。存在しないエージェントやカテゴリを指すルール、名前の重複、自分自身への許可、型の誤りなどを、ファイル内の場所付きですべて報告し、D1を変更せずに止まる。
- エージェント、カテゴリ、許可ルールのどれかがすでにD1にあるときも、変更せずに止まる。初期値の投入は最初の一度だけ行う。
- 投入は1つのトランザクションで行う。途中で失敗した場合は何も入らない。
- 本番への投入中は、D1が一時的に応答しなくなることがある（wranglerが警告を表示する）。

一時停止・再開・トークン失効以外の変更（エージェントの追加・削除や許可ルール・カテゴリの編集）は、管理画面や管理ボットで行う（「3. トークンを発行する」の「停止・再開とトークンの失効」および「ルールとカテゴリの編集」を参照）。

## 3. トークンを発行する

エージェントごとに、MCP接続用のトークンを発行する。

```sh
npm run -s token -- --local muse
npm run -s token -- --remote muse
```

- トークンの平文は標準出力に一度だけ表示される。その場でエージェントのコネクタ設定に貼る。D1にはハッシュ値だけが入り、あとから平文を取り出す方法はない。
- 同じエージェントにもう一度発行すると、古いトークンはその時点で無効になる。トークンを失くしたときや漏れたときは再発行する。
- `-s` を付けると npm の前置きの表示が消え、標準出力にはトークンだけが出る。案内文は標準エラー出力に出る。

エージェントは、paabの `/mcp` に `Authorization: Bearer <トークン>` ヘッダーを付けて接続する。

### 停止・再開とトークンの失効

エージェントの暴走時やトークンの漏洩時のために、次のコマンドがある。

```sh
npm run -s suspend -- --local muse       # 停止（すべてのリクエストが 403 になる）
npm run -s resume -- --local muse        # 再開
npm run -s revoke-token -- --local muse  # 有効なトークンをすべて失効させる
```

- `suspend` はエージェントの `status` を `suspended` に変える。停止中は `check_inbox` や `answer` を含め、そのエージェントのリクエストをすべて断る。すでに受信箱にある項目は再開されるか 7 日経過による期限切れまで保持する（設計書 3.5・5.1 節）。
- `revoke-token` は `participant` 以外の用途のトークンも含め、そのエージェントの有効なトークンをすべて失効させる。再発行は `npm run token` で行う。
- これらの操作自体は監査ログに記録されない。停止や失効の効果は、その後のリクエストが `auth_failed` として記録されることでたどれる。変更の記録（誰が、いつ、何を変えたか）は管理操作の change log（第2段階）で扱う。
- エージェントの追加・質問数上限の変更・許可ルールやカテゴリの変更は、第2段階の管理画面までコマンドを用意しない。それまでは `npx wrangler d1 execute DB --local --command "..."`（本番は `--remote --config wrangler.local.jsonc`）で SQL を直接実行する。直接SQLでは記録が残らないので、変えた内容は利用者が控えておく。

## 4. 監査ログを見る

```sh
npm run -s audit-log -- --local
npm run -s audit-log -- --remote --since 2026-11-01 --from muse --outcome denied
```

| オプション | 内容 |
| --- | --- |
| `--since <日時>` | この日時以降の記録 |
| `--before <日時>` | この日時より前の記録（この日時は含まない） |
| `--from <名前>` | 送信元のエージェント |
| `--to <名前>` | 宛先のエージェント |
| `--category <名前>` | カテゴリ |
| `--outcome <結果>` | `ok`、`denied`、`expired` のいずれか |
| `--limit <件数>` | 最大件数。既定は100、上限は1000。記録された順の逆（新しい順）に返す |
| `--body` | 本文の列を付ける。本文は監査ログへの本文記録（`AUDIT_RECORD_BODIES`）が有効なときだけ残る |
| `--oldest` | 新しい順の代わりに、記録された順（古い順）に返す |
| `--after-id <ID>` | このIDより後の記録だけを返す |
| `--before-id <ID>` | このIDより前の記録だけを返す |

- 日時は `2026-11-01`（実行したマシンのタイムゾーンでのその日の0時）か、`2026-11-01T09:00+09:00` のようにオフセット付きで書く。オフセットのない時刻は受け付けない。
- 既定では記録された順の逆（`id` の降順）に最大100件を表示する（並行リクエストなどでは `occurred_at` 列の時刻が前後することがある）。件数が上限に達したときは、続きを読むための指定（`--before-id`、古い順では `--after-id`）を標準エラー出力に出す。
- 出力はタブ区切りで、1行目が見出しである。先頭の `id` 列は `--after-id` と `--before-id` に渡す値である。日時は実行したマシンのタイムゾーンで表示する。
- 送信元や宛先は名前で表示する。削除されたエージェントやカテゴリはIDで表示する。
- 理由（`reason_code`）は監査ログにだけ残る内部の理由で、質問したエージェントには返されない（設計書 3.4 節）。

## ローカルでの確認手順

初期値の投入から接続の確認までを、ローカルで通す例。

```sh
npm ci
npx wrangler d1 migrations apply DB --local
cp paab.seed.example.json paab.seed.json
npm run seed -- --local
TOKEN=$(npm run -s token -- --local muse)
npm run dev
```

別の端末で、発行したトークンでMCPに接続できることを確かめる。

```sh
curl -s http://localhost:8787/mcp \
	-H "Authorization: Bearer $TOKEN" \
	-H "Content-Type: application/json" \
	-H "Accept: application/json, text/event-stream" \
	-d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

トークンが正しければ `initialize` の結果が返り、誤っていれば401が返る。

## 2つのクライアントで質問応答を試す

質問して回答を得る1往復を、手元で2つのクライアントから試す手順。上の「ローカルでの確認手順」で初期値を投入し、`npm run dev` を起動してあるものとする。同じ筋書きは `test/e2e/` のテストが `npm run test` で確かめている。

見本の初期値では、`muse` は `grok` に「仕事」と「好み・習慣」を質問できる。ここでは `muse` を質問側、`grok` を回答側にする。

1. 別の端末で、2体分のトークンを発行する。再発行すると古いトークンは無効になるので、`muse` のトークンも発行し直した値を使う。

   ```sh
   MUSE_TOKEN=$(npm run -s token -- --local muse)
   GROK_TOKEN=$(npm run -s token -- --local grok)
   ```

2. ツールを呼ぶシェル関数を用意する。引数はトークン、ツール名、ツールの引数（JSON。省略すると `{}`）である。

   ```sh
   tool() {
   	curl -s http://localhost:8787/mcp \
   		-H "Authorization: Bearer $1" \
   		-H "Content-Type: application/json" \
   		-H "Accept: application/json, text/event-stream" \
   		-d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":${3:-{\}}}}"
   	echo
   }
   ```

   結果は `data:` で始まる行のJSONで返る。ツールの出力は `result.content[0].text` に入っている。

3. `muse` が、質問できる相手とカテゴリを確かめる。`grok` と「仕事, 好み・習慣」が返る。

   ```sh
   tool "$MUSE_TOKEN" list_agents
   ```

4. `muse` が `grok` に質問する。返ってきた `question_id` を控える。

   ```sh
   tool "$MUSE_TOKEN" ask '{"to":"grok","category":"仕事","question":"今週の締め切りは？"}'
   ```

5. `grok` が質問を受け取り、控えた `question_id` を指定して回答する。

   ```sh
   tool "$GROK_TOKEN" check_inbox
   tool "$GROK_TOKEN" answer '{"question_id":"<question_id>","action":"answer","text":"金曜日です。"}'
   ```

6. `muse` が回答を受け取る。`kind: answer` のメッセージが返る。メッセージは一度しか渡されないので、もう一度呼ぶと `no new messages` になる。

   ```sh
   tool "$MUSE_TOKEN" check_inbox
   ```

7. 監査ログを見る。新しい順に `question_answered`、`question_delivered`、`question_accepted` が並び、`--body` を付けても本文の列は `-` のままである。

   ```sh
   npm run -s audit-log -- --local --body
   ```

拒否も同じ関数で試せる。

- **許可のないカテゴリ**: 手順4の `category` を `その他` にする。`ask` の返事は許可された質問と同じ形だが、`grok` の `check_inbox` には何も届かず、`muse` の `check_inbox` に `kind: rejection` が届く。監査ログには `question_blocked` と理由 `no_allow_rule` が残る。
- **回答側の拒否**: 手順5の `answer` の引数を `{"question_id":"<question_id>","action":"decline"}` にする。`muse` に届く `kind: rejection` は、上の場合と同じ形である。
- **他人宛の質問への回答**: 手順5の `answer` を `$MUSE_TOKEN` で呼ぶ。エラーになり、質問は開いたまま残る。
- **期限切れ**: 7日を過ぎた質問は回答できない。期限切れの処理は1時間ごとの定期実行が行う。ローカルでは定期実行が自動で動かないので、`curl "http://localhost:8787/cdn-cgi/local/scheduled"` で起動する。7日待たずに確かめるには `test/e2e/` のテストを使う。

## 本番へのデプロイ

準備で作った `wrangler.local.jsonc` を使って、自分の Cloudflare アカウントに Worker をデプロイする。

```sh
npm run deploy
```

`npm run deploy` は `wrangler deploy --config wrangler.local.jsonc` を実行する。終わると `https://paab.<サブドメイン>.workers.dev` のような URL が表示される。

動いていることは `/health` で確かめる。`ok` が返ればよい。

```sh
curl -s https://paab.<サブドメイン>.workers.dev/health
```

エージェントに設定する接続先は `https://paab.<サブドメイン>.workers.dev/mcp` である。トークンは「3. トークンを発行する」のコマンドに `--remote` を付けて発行する（管理コマンドは `--remote` 時に既定で `wrangler.local.jsonc` を使い、`--config <パス>` で変更できる）。

### 設定値

`wrangler.local.jsonc` の `vars` にある。変えたら `npm run deploy` で反映する。

| 設定値 | 内容 | 既定 |
| --- | --- | --- |
| `AUDIT_RECORD_BODIES` | `"true"` なら監査ログに質問と回答の本文を記録する。`"false"` なら記録しない | `"false"` |
| `AUDIT_BODY_RETENTION_DAYS` | 記録した本文を保持する日数。正の整数でないと本文は記録されない。期限を過ぎた本文は定期実行で消える（監査ログの行自体は残る）。記録を止めると残っていた本文も次の定期実行で消える | `"30"` |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Zero Trust のチームドメイン（例: `<チーム名>.cloudflareaccess.com`）。`CF_ACCESS_AUD` と組で設定する | `""` |
| `CF_ACCESS_AUD` | Cloudflare Access アプリケーションの Application Audience (AUD) Tag | `""` |
| `ALLOW_LOCAL_WEBHOOKS` | `"true"` のときだけ、ローカル開発用に `http://` や `localhost`・プライベート IP 宛の Webhook URL を許可する。本番の `wrangler.local.jsonc` には設定しない | `""`（不許可） |

### 管理画面の保護（Cloudflare Access）

`/admin` と `/admin/*` は利用者本人だけが開けるように、Cloudflare Access を前段に置く。未設定または設定が不完全な状態では Worker は `503` を返して遮断する（フェイルクローズ）。

1. **ログイン元（GitHub）を用意する**
   Cloudflare Zero Trust ダッシュボードの **Settings** > **Authentication** > **Login methods** で **GitHub**（OAuth App）を追加する。GitHub のパスキー利用時に Cloudflare Access で拒否される報告があるため（[設計書 8 節](design.md#8-未確認の事実)）、初回ログイン時は確認すること。
2. **Access アプリケーションを作る**
   Zero Trust の **Access** > **Applications** で Self-hosted アプリケーションを作り、保護対象パスに `/admin` と `/admin/*`（例: `paab.<サブドメイン>.workers.dev/admin` と `paab.<サブドメイン>.workers.dev/admin/*`）を指定する。許可ポリシーには利用者本人のメールアドレスだけを含める。
   - `/mcp`、`/mcp/admin`、`/unread`、`/health` は保護対象に含めない。エージェントの `Authorization: Bearer` 通信や定期確認スクリプト、死活監視が Access のログイン画面で遮断されるためである。アプリケーションの対象パスを `/admin` と `/admin/*` に限定する（ドメイン全体を対象にした場合は `/mcp`、`/mcp/admin`、`/unread`、`/health` に Bypass ポリシーを設定する）。
3. **Worker 側で JWT 検証を有効にする**
   アプリケーション設定画面の **Application Audience (AUD) Tag** と Zero Trust のチームドメインを控え、`wrangler.local.jsonc` の `vars` に書いて `npm run deploy` する。

   ```jsonc
   "vars": {
   	"AUDIT_RECORD_BODIES": "false",
   	"AUDIT_BODY_RETENTION_DAYS": "30",
   	"CF_ACCESS_TEAM_DOMAIN": "<チーム名>.cloudflareaccess.com",
   	"CF_ACCESS_AUD": "<Application Audience Tag>"
   }
   ```

   Worker はリクエストごとに `Cf-Access-Jwt-Assertion` ヘッダーの RS256 署名（`https://<チームドメイン>/cdn-cgi/access/certs` の公開鍵）と `aud`・`exp`・`nbf` を検証する。Access の設定漏れや `workers.dev` への直接アクセスでも認証を回避できない。

4. **ローカル開発（`ADMIN_DEV_USER`）**
   `npm run dev` では Cloudflare Access を通さないため、`.dev.vars` に `ADMIN_DEV_USER` を書くと開発モードとして `/admin` を開ける（`.dev.vars` は git の管理外）。

   ```sh
   echo 'ADMIN_DEV_USER=local@example.com' >> .dev.vars
   ```

   `CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` のどちらか一方でも設定されている場合は `ADMIN_DEV_USER` は無視され、Access 設定が優先される。本番の `wrangler.local.jsonc` には `ADMIN_DEV_USER` を書かないこと。

### 管理画面からのエージェント管理とトークン発行（`/admin/agents`）

Cloudflare Access（ローカル開発では `ADMIN_DEV_USER`）を設定した状態で `/admin/agents` を開くと、エージェント、参加者トークン（`/mcp` 用）、件数確認トークン（`/unread` 用）をブラウザから管理できる。

1. **エージェントの登録と更新**
   - 「新しいエージェントを登録」フォームに `name`、任意の説明文、`daily_question_limit`（0 以上の整数）、任意の `owner_id` を入力して登録する。`owner_id` を空欄にした場合は既定値（既存エージェントの `owner_id`、未登録時は `me`）が使われる。
   - 各エージェントカードのフォームから、説明文と 1 日あたりの質問数上限を更新できる。
2. **停止・再開と削除**
   - 「停止する」を押すと状態が `suspended` になり、`/mcp`、`/mcp/admin`、`/unread` へのリクエストが HTTP `403` で拒否される。「再開する」で元に戻る。
   - 「削除…」から確認画面（`/admin/agents/:id/delete`）へ進み、対象や影響（紐づくトークン・許可ルール・メッセージも削除され、`audit_log` と `change_log` の記録は残ること）を確認したうえで削除を実行する。
3. **参加者トークンの発行・再発行・失効**
   - 「参加者トークンを発行」または「参加者トークンを再発行」を実行すると、応答画面に新しい平文トークンが**一度だけ**表示される（`Cache-Control: no-store`）。D1 や `change_log` には保存されないため、その場でコピーしてエージェントの MCP 設定（`Authorization: Bearer <トークン>`）へ登録する。
   - 有効なトークンがある状態で再発行すると、以前のトークンは即座に無効になる。「参加者トークンを失効」を押した場合も、現在有効な参加者トークンは即座に使えなくなる。
   - すべての変更操作は、Access でログインしたユーザーのメールアドレスを `actor_id` として `change_log` に記録される。
4. **件数確認トークン（`unread_count`）の発行・再発行・失効と `/unread` の利用**
   - エージェントごとに、`purpose = "unread_count"` の件数確認トークンを参加者トークン（`/mcp` 用）とは独立して発行・再発行・失効できる（`npm run token` コマンドは参加者トークン専用のため、件数確認トークンの発行は `/admin/agents` から行う。`npm run revoke-token` は件数確認トークンを含めて全用途のトークンを失効させる）。
   - 「件数確認トークンを発行」または「件数確認トークンを再発行」を実行すると、平文トークンが**一度だけ**表示される（`Cache-Control: no-store`）。この操作は同じエージェントの参加者トークンや管理者トークンには影響しない。
   - 件数確認トークンは、VM 上の定期確認スクリプトなどに配置する想定である。取得できるのは未読件数だけであり、メッセージ本文・ID・送信元・カテゴリは読めない。
   - 定期確認スクリプトからは `GET /unread` に `Authorization: Bearer <件数確認トークン>` を付けて問い合わせる。

     ```sh
     curl -s https://paab.<サブドメイン>.workers.dev/unread \
     	-H "Authorization: Bearer <件数確認トークン>"
     ```

   - 応答は `{"unread": <件数>}`（`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`）で、有効かつ未受取・期限内のメッセージ数だけを返し、`received_at` は更新しない。トークン不正・用途違い（参加者トークンや管理者トークンを含む）では HTTP `401`、エージェントが `suspended` 状態では HTTP `403`、`GET` 以外のメソッドでは HTTP `405`（`Allow: GET`）を返す。
5. **Webhook による新着通知（呼び出し先 URL と署名鍵）**
   - Webhook 通知に対応したエージェントには、`/admin/agents` の各エージェントカードから呼び出し先 URL を登録できる。この設定は画面から人間だけが実行でき、`/mcp` と `/mcp/admin` には Webhook の設定・署名鍵参照ツールを出さない（[設計書 2.3 節](design.md#23-規則)）。
   - 本番環境では `https://` の公開 URL だけを受け付ける。URL に埋め込まれたユーザー名・パスワード、`http://`、`localhost`、`.localhost`、`.local`、`.internal`、およびループバック・プライベート・リンクローカル IP（`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`::1`、`fc00::/7`、`fe80::/10` など）は保存時と配送直前の両方で拒否する。
   - 登録・更新を実行すると 256 bit の署名鍵（`signing_secret`）が生成され、画面に**一度だけ**表示される（`Cache-Control: no-store`）。以後の GET や `change_log` には URL のみが残り、署名鍵は再表示されない。
   - 新着通知のリクエストは次の固定形式で `POST` される（タイムアウト 5 秒、リダイレクト拒否）。メッセージ本文、質問 ID、送信元、カテゴリは送信しない。
     - ボディ（固定）: `{"event":"inbox_wake"}`
     - `X-Paab-Timestamp`: UNIX 秒の整数文字列
     - `X-Paab-Signature`: `sha256=<HMAC-SHA256 hex("${timestamp}.${rawBody}", signing_secret)>`
   - 受信側は `X-Paab-Timestamp` の鮮度（例: ±300 秒以内）を確認し、`${X-Paab-Timestamp}.${rawBody}` に対する HMAC-SHA256 を定数時間比較（`timingSafeEqual`）で検証してから `/mcp` の `check_inbox` を呼ぶ。
   - 同一エージェントへの未送信通知は 1 件に統合される。許可された `ask` と `answer` / `decline` はリクエスト末尾の `waitUntil` で初回送信を試み、失敗時は定期実行で最大 3 回（60 秒後、300 秒後）まで再試行する。3 回失敗すると配信を打ち切り、監査ログに `webhook_failed`（理由 `webhook_delivery_failed`）を記録する。ブリッジが拒否した `ask` はタイミング差で拒否理由が漏れないよう初回即時送信を行わず、遅延キューに積む。Webhook が失敗しても受信箱のメッセージは失われない。
   - ローカル開発で `http://localhost:...` 宛のテスト受信サーバーを使う場合だけ、`.dev.vars` に `ALLOW_LOCAL_WEBHOOKS=true` を書く。再試行や期限切れ通知をローカルで進めるには `curl "http://localhost:8787/cdn-cgi/local/scheduled"` を実行する。

### VM 上の定期確認スクリプト（`examples/poll-unread.sh`）

エージェントが動く VM 側から 5 分おきに未読件数を確認し、1 件以上のときだけエージェントを起こす見本スクリプトを `examples/` に同梱している（[設計書 2.5 節](design.md#25-vm上の定期確認スクリプト確定)）。確認は `GET /unread` への HTTP リクエストだけで完結するため、AI の利用枠を消費せず、外部から到達可能な入口がない VM でも使える。

1. **件数確認トークンをファイルに保存する（`chmod 600`）**
   `/admin/agents` で発行した `unread_count` トークンを、所有者だけが読めるファイルに 1 行で保存する。環境変数や crontab に平文トークンを直接書くとプロセス一覧やログから漏れるおそれがあるため、`PAAB_UNREAD_TOKEN_FILE` を使う。

   ```sh
   mkdir -p ~/.config/paab ~/.local/state/paab
   umask 077 && printf '%s\n' '<件数確認トークン>' > ~/.config/paab/unread-token
   chmod 600 ~/.config/paab/unread-token
   ```

2. **起こし方のスクリプト（`examples/wake-agent.sh`）を差し替える**
   `examples/poll-unread.sh` は `unread > 0` のときだけ既定で隣にある `examples/wake-agent.sh` を第 1 引数に未読件数を渡して呼び出す（`cron` 実行時にカレントディレクトリが異なっていてもスクリプト自身の場所から解決する）。`examples/wake-agent.sh` を編集して自分のエージェントの起動コマンドやローカル通知先へ書き換えるか、`PAAB_WAKE_CMD` 環境変数で別の実行可能スクリプトを指定する。

   動作確認の例（未読が 0 件なら何も出力せず終了コード 0 で終わる）:

   ```sh
   PAAB_URL=https://paab.<サブドメイン>.workers.dev \
   	PAAB_UNREAD_TOKEN_FILE=~/.config/paab/unread-token \
   	./examples/poll-unread.sh
   ```

   接続先 URL 全体を上書きしたいときは `PAAB_UNREAD_URL` を使う。`PAAB_UNREAD_TOKEN_FILE` の代わりに `PAAB_UNREAD_TOKEN` を使うこともできる。

3. **cron に登録する（`examples/paab-poll.cron`）**
   `examples/paab-poll.cron` には `*/5 * * * *` の定期実行例を入れている。`cron` は最小限の `PATH`（`/usr/bin:/bin` など）で動くため、ファイルの `PATH=` に `curl` と `PAAB_WAKE_CMD` が使うコマンドのディレクトリを含め、絶対パスとログ出力先を自分の環境に合わせて書き換えてから `crontab examples/paab-poll.cron` で登録する。

### ルールとカテゴリの編集（`/admin/rules`）

`/admin/rules` から、許可ルールと質問カテゴリを編集できる。変更は即時反映され、変更履歴（`change_log`）に新しい順で記録される。

- **許可ルール（一方向）**: 許可ルールは「送信元 → 宛先」の向きごとに管理する。`A → B` を許可しても `B → A` は許可されない。不要なルールは各行の **取り消す** で削除する。
- **「その他」カテゴリの扱い**: 「その他」は初期状態ではどの組み合わせにも許可されていない（[設計書 3.2 節](design.md#32-カテゴリ確定)）。必要な場合だけ明示的に許可する。
- **カテゴリの追加と削除**: 1〜64文字（NFC 正規化後、カンマ・改行・制御文字不可）でカテゴリを追加できる。**削除** を開くと、そのカテゴリを使っている許可ルールの件数が確認画面に表示され、確定するとカテゴリと該当ルールが同時に削除される。

### 管理者ボットの指名と接続（`/admin/adminbot`・`/mcp/admin`）

`/admin/adminbot` から、ブリッジ管理用の管理者ボットを同時に 1 体だけ指名し、管理者トークン（`purpose = "admin"`）を発行・再発行・失効できる（[設計書 5.2・5.3 節](design.md#52-人間だけができること確定)）。

1. **管理者ボットの指名・変更・解除**
   - 登録済みエージェントから 1 体を選んで指名する。
   - 別のエージェントへ指名替えしたり指名を解除したりすると、前の管理者ボットの管理者トークンは直ちに失効し、任意の権限スイッチ（本文閲覧・最高管理者権限）はオフにリセットされる。
   - 変更履歴は `change_log` に記録される。
2. **管理者トークンの発行・再発行・失効**
   - 指名中の管理者ボットに対して「管理者トークンを発行」または「管理者トークンを再発行」を実行すると、平文トークンが**一度だけ**表示される（`Cache-Control: no-store`）。サーバーや `change_log` には保存されない。
   - 管理者トークンは、参加者として質問・回答を行う `/mcp` 用トークンとは別である。管理者トークンを `/mcp` に送っても拒否され、参加者トークンを `/mcp/admin` に送っても拒否される。
3. **`/mcp/admin` への接続**
   - 管理者ボットは `https://<Worker URL>/mcp/admin` に `Authorization: Bearer <管理者トークン>` ヘッダーを付けて接続する。
   - 指名されていないエージェント、`suspended` 状態のエージェント、または失効済みトークンでの接続は拒否され、監査ログに `auth_failed` が記録される。
   - トークンの発行・再発行、エージェントの登録・削除、管理者ボットの指名替え、権限スイッチの変更は人間専用の操作であり、`/mcp/admin` からは実行できない。`view_audit_log` ツールで監査ログを参照でき（既定は本文なし）、呼び出しは監査ログに `admin_tool_called` として記録される。
4. **本文閲覧スイッチ（`read_bodies`）**
   - `/admin/adminbot` のスイッチからオン／オフを切り替える（既定はオフ。`/mcp/admin` からは切り替えられない）。質問文や回答文に個人情報が含まれる可能性があるため、調査が必要な間だけ有効にする。
   - オンのあいだ、管理者ボットが `view_audit_log` に `include_body: true` を指定して呼ぶと、監査ログに記録された本文を信頼できない外部データの枠（`<untrusted_external_data>`）付きで受け取り、閲覧した事実が `admin_body_read` として監査ログに残る。
   - 監査ログへの本文記録（`AUDIT_RECORD_BODIES`）がオフのときは本文自体が保存されていないため、画面にその旨の案内が出て本文は返されない。最高管理者権限が有効な状態でオンにする場合は確認画面を1回挟む。変更履歴は `change_log` に `admin_bot_switches_updated` として記録される。
5. **最高管理者権限スイッチ（`superadmin`）**
   - `/admin/adminbot` の **最高管理者権限** から有効期限（`1日`、`7日`（既定）、`30日`、`無期限`）を選んでオンにする（既定はオフ。`/mcp/admin` からはオン・延長・変更のいずれもできない）。有効期限を過ぎると即座に通常権限へ戻る。オンのあいだも、画面の **オフにする** からいつでも無効化できる。
   - オンのあいだ、緩める操作（`propose_allow_rule`、`propose_category`、`propose_daily_limit_raise`、`propose_resume_agent`）は `/admin/proposals` での承認を待たずに即時反映される（`status: executed`、`change_id` 付き。`change_log` には `actor_type = 'admin_bot'`、`approver_id = NULL` として記録される）。
   - 最高管理者権限が有効でも、エージェントの登録・削除、トークンの発行・再発行・失効、管理者ボットの指名変更・解除、権限スイッチ（`read_bodies`・`superadmin`）の変更、管理者ボット自身の説明文の承認、監査ログの停止・削除は `/mcp/admin` からは実行できない（[設計書 5.2・5.3 節](design.md#52-人間だけができること確定)）。
   - 本文閲覧がオンの状態で最高管理者権限をオンにする瞬間（および最高管理者権限が有効な状態で本文閲覧をオンにする瞬間）は、参加者質問を通じたプロンプトインジェクションによる設定変更のリスクを確認する画面を1回挟む。
   - 管理者ボットが実行した変更（締める操作と最高管理者権限での即時反映のどちらも）は `/admin/adminbot` の **管理者ボットによる変更履歴** に表示され、**元に戻す** で 1 操作で巻き戻せる。スイッチの切り替え自体は `change_log` に `admin_bot_switches_updated` として記録される。

### 新しい版への更新

新しい版を取り込むときは、更新された `wrangler.jsonc` との差分（`compatibility_date`、bindings、`vars`、`triggers.crons` の追加など）を先に `wrangler.local.jsonc` へ反映し、`database_id` と自分の `vars` を保ったままマイグレーションを適用してデプロイする。

```sh
git pull
diff -u wrangler.jsonc wrangler.local.jsonc
npm ci
npx wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc
npm run deploy
```

### 定期実行

デプロイされた Worker は、`triggers.crons` の `0 * * * *` で1時間ごとに定期実行を行う。内容は、期限切れになった質問を期限切れとして処理して監査ログに記録すること、受け取りから24時間を過ぎたメッセージ本文および一度も受け取られずに期限切れになった質問の本文を消すこと（設計書 4 節）、期限切れ質問の質問者へ Webhook 通知を予約すること、再試行待ちを含む期限到達済みの Webhook を送信すること、期限を過ぎた管理者ボット提案を期限切れにすること、ならびに保持期間を過ぎた監査ログの本文を消すことである。ローカルでは定期実行は自動で動かない。ローカルでの確かめ方は「2つのクライアントで質問応答を試す」の「期限切れ」を参照。

## 依存と Actions の更新

- npm の依存と GitHub Actions の更新は Dependabot が週1回 PR にする。Actions はコミットで固定しているため、更新 PR が新しいコミットを指す。
- CI は `npm audit --omit=dev --audit-level=high` を含む。本番依存に high 以上の脆弱性が見つかると CI が落ちるので、更新 PR で直す。
- `wrangler.jsonc` の `compatibility_date` は、wrangler を更新するときに一緒に進める。進める前に `npm run check` と `npm run dev` での起動を確かめ、変更は単独のコミットにする。

## 補足

- 対応プラン: Workers Free で動く。`db.batch` の1回が Workers Free の上限（1呼び出しあたり50クエリ）に対して1回と数えられる前提では、`check_inbox` の監査記録や定期実行の期限切れ処理は25件単位の `db.batch` でまとめるため、クエリ数は25件ごとのバッチ数に応じて増え、通常の運用では上限内に収まる（`db.batch` が文ごとに数えられるかどうかは Cloudflare の公式文書に明記がなく未確認）。
- コマンドは `scripts/paab.ts` を esbuild でまとめてから Node で実行する。まとめた結果は `.wrangler/tmp/paab-cli.mjs` に置かれる。
- ローカルのD1の保存先を変えるには `--persist-to <ディレクトリ>` を付ける（`--local` のときだけ）。`wrangler dev` にも同じ値を渡す。
- `--remote` を付けた管理コマンド（`seed`、`token`、`audit-log`、`suspend`、`resume`、`revoke-token`）は、既定で `wrangler.local.jsonc` を読む。別の設定ファイルを使うには `--config <パス>` を付ける。
