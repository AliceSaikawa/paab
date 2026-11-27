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

一時停止・再開・トークン失効以外の変更（エージェントの追加・削除や許可ルール・カテゴリの編集）は、第2段階の管理画面で用意する（「3. トークンを発行する」の「停止・再開とトークンの失効」を参照）。

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

- `suspend` はエージェントの `status` を `suspended` に変える。停止中は `check_inbox` や `answer` を含め、そのエージェントのリクエストをすべて断る。
- `revoke-token` は `participant` 以外の用途のトークンも含め、そのエージェントの有効なトークンをすべて失効させる。再発行は `npm run token` で行う。
- これらの操作自体は監査ログに記録されない。停止や失効の効果は、その後のリクエストが `auth_failed` として記録されることでたどれる。変更の記録（誰が、いつ、何を変えたか）は管理操作の change log（第2段階）で扱う。
- エージェントの追加・質問数上限の変更・許可ルールやカテゴリの変更は、第2段階の管理画面までコマンドを用意しない。それまでは `npx wrangler d1 execute DB --local --command "..."`（本番は `--remote --config wrangler.local.jsonc` に変える）で SQL を直接実行する。直接SQLでは記録が残らないので、変えた内容は利用者が控えておく。

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
- **期限切れ**: 7日を過ぎた質問は回答できない。期限切れの処理は 1 時間ごとの定期実行（`0 * * * *`：質問の期限切れ、本文削除、監査ログ本文削除、提案の期限切れ、および Webhook 配達）が行う。毎分の定期実行（`* * * * *`）は保留中 Webhook 配達・再試行・拒否質問の 60 秒遅延通知と `suspended` 破棄のみを行う。ローカルでは定期実行が自動で動かないので、`curl "http://localhost:8787/cdn-cgi/local/scheduled"` で全定期処理を起動する。7日待たずに確かめるには `test/e2e/` のテストを使う。

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

エージェントに設定する接続先は `https://paab.<サブドメイン>.workers.dev/mcp` である。トークンは「3. トークンを発行する」のコマンドに `--remote` を付けて発行する（`seed`、`token`、`audit-log`、`suspend`、`resume`、`revoke-token` に `--remote` を付けたときは既定で `wrangler.local.jsonc` を読み、`--config <パス>` で変えられる）。

### 設定値

`wrangler.local.jsonc` の `vars` にある。変えたら `npm run deploy` で反映する。

| 設定値 | 内容 | 既定 |
| --- | --- | --- |
| `AUDIT_RECORD_BODIES` | `"true"` なら監査ログに質問と回答の本文を記録する。`"false"` なら記録しない | `"false"` |
| `AUDIT_BODY_RETENTION_DAYS` | 記録した本文を保持する日数。正の整数でないと本文は記録されない。期限を過ぎた本文は定期実行で消える（監査ログの行自体は残る）。記録を止めると残っていた本文も次の定期実行で消える | `"30"` |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Zero Trust のチームドメイン（例: `<チーム名>.cloudflareaccess.com`）。`CF_ACCESS_AUD` と組で設定する | `""` |
| `CF_ACCESS_AUD` | Cloudflare Access アプリケーションの Application Audience (AUD) Tag | `""` |
| `WEBHOOK_ALLOW_INSECURE_LOCALHOST` | ローカル試験時のみ `"true"` を設定すると、Webhook 呼び出し先として `http://localhost` / `http://127.0.0.1` / `http://[::1]` を例外許可する。本番の `wrangler.local.jsonc` には設定しない | 未設定（`false`） |

### 管理画面の保護（Cloudflare Access）

`/admin` と `/admin/*` は利用者本人だけが開けるように、Cloudflare Access を前段に置く。未設定または設定が不完全な状態では Worker は `503` を返して遮断する（フェイルクローズ）。

1. **ログイン元（GitHub）を用意する**
   Cloudflare Zero Trust ダッシュボードの **Settings** > **Authentication** > **Login methods** で **GitHub**（OAuth App）を追加する。GitHub のパスキー利用時に Cloudflare Access で拒否される報告があるため（[設計書 8 節](design.md#8-未確認の事実)）、初回ログイン時は確認すること。
2. **Access アプリケーションを作る**
   Zero Trust の **Access** > **Applications** で Self-hosted アプリケーションを作り、保護対象パスに `/admin` と `/admin/*`（例: `paab.<サブドメイン>.workers.dev/admin` と `paab.<サブドメイン>.workers.dev/admin/*`）を指定する。許可ポリシーには利用者本人のメールアドレスだけを含める。
   - `/mcp`、`/mcp/admin`、`/unread`、`/health` は保護対象に含めない。エージェントの `Authorization: Bearer` 通信（MCP 接続や未読件数の定期確認）や死活監視が Access のログイン画面で遮断されるためである。アプリケーションの対象パスを `/admin` と `/admin/*` に限定する（ドメイン全体を対象にした場合は `/mcp`、`/mcp/admin`、`/unread`、`/health` に Bypass ポリシーを設定する）。
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

Cloudflare Access（ローカル開発では `ADMIN_DEV_USER`）を設定した状態で `/admin/agents` を開くと、エージェントとトークン（参加者トークン・件数確認トークン）をブラウザから管理できる。

1. **エージェントの登録と更新**
   - 「新しいエージェントを登録」フォームに `name`、任意の説明文、`daily_question_limit`（0 以上の整数）、任意の `owner_id` を入力して登録する。`owner_id` を空欄にした場合は既定値（既存エージェントの `owner_id`、未登録時は `me`）が使われる。
   - 各エージェントカードのフォームから、説明文と 1 日あたりの質問数上限を更新できる。
2. **停止・再開と削除**
   - 「停止する」を押すと状態が `suspended` になり、`/mcp`・`/unread`（管理者ボットなら `/mcp/admin` も）へのリクエストが HTTP `403` で拒否される。「再開する」で元に戻る。
   - 「削除…」から確認画面（`/admin/agents/:id/delete`）へ進み、対象や影響（紐づくトークン・許可ルール・メッセージも削除され、`audit_log` と `change_log` の記録は残ること）を確認したうえで削除を実行する。
3. **参加者トークン・件数確認トークンの発行・再発行・失効**
   - 「参加者トークンを発行」または「参加者トークンを再発行」を実行すると、応答画面に新しい平文トークンが**一度だけ**表示される（`Cache-Control: no-store`）。D1 や `change_log` には保存されないため、その場でコピーしてエージェントの MCP 設定（`Authorization: Bearer <トークン>`）へ登録する。
   - 同様に、各エージェントカードの「件数確認トークン（`unread_count`）」から未読件数窓口 `GET /unread` 専用のトークンを発行・再発行・失効できる（詳細は下の「未読件数窓口と件数確認トークン（`GET /unread`）」を参照）。
   - いずれも有効なトークンがある状態で再発行すると、以前の同用途トークンは即座に無効になる。「失効」を押した場合も即座に使えなくなる（参加者トークンと件数確認トークンは互いに独立している）。
   - すべての変更操作は、Access でログインしたユーザーのメールアドレスを `actor_id` として `change_log` に記録される。

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
   - トークンの発行・再発行、エージェントの登録・削除、管理者ボットの指名替え、権限スイッチの変更は人間専用の操作であり、`/mcp/admin` からは実行できない。`view_audit_log` ツールで監査ログ（本文なし）を参照でき、呼び出しは監査ログに `admin_tool_called` として記録される。

### 未読件数窓口と件数確認トークン（`GET /unread`）

エージェントの VM 上で動く定期確認スクリプトなどから、AI 利用枠を消費せずに未読件数だけを確認するための非 MCP 窓口として `GET /unread` を提供する（[設計書 2.5 節](design.md#25-vm上の定期確認スクリプト確定)・[起動設計 4.3 節](agent-trigger-design.md#43-未読件数窓口get-unreadとポーリングフック運用確定提案)）。

1. **件数確認トークン（`purpose = "unread_count"`）の前提と権限**
   - 件数確認トークンは、MCP コネクタ用の参加者トークン（`participant`）や管理者トークン（`admin`）とは別物で、エージェントの VM 内（定期確認スクリプト側）に配置する前提の低権限トークンである。
   - 万一このトークンが漏えいしても取得できるのは未読件数（整数）のみであり、質問・回答・拒否の本文やメッセージ ID の閲覧、`/mcp` や `/mcp/admin` の呼び出しは一切できない。逆に、参加者トークンや管理者トークンを `GET /unread` に送っても HTTP `401` で拒否される。
2. **`/admin/agents` からの発行・再発行・失効**
   - `/admin/agents` を開き、対象エージェントのカードにある「件数確認トークン（`unread_count`）」から「件数確認トークンを発行」または「件数確認トークンを再発行」を実行する。
   - 平文トークンは応答画面に**一度だけ**表示される（`Cache-Control: no-store`）。サーバーや `change_log` には保存されないため、その場でコピーして VM 側の設定へ控える。
   - 再発行または「件数確認トークンを失効」を実行すると、以前の件数確認トークンは即座に無効になる（操作は `change_log` に記録される）。
3. **`GET /unread` の呼び出しと応答**
   - 認証は `Authorization: Bearer <件数確認トークン>` ヘッダーのみを受け付ける。`?token=...` のような URL クエリパラメータはログ漏えい防止のため受け付けない（`401` を返す）。
   - Cloudflare Access を使っている場合は、上の「管理画面の保護（Cloudflare Access）」のとおり `/unread` を保護対象から外す（または Bypass ポリシーを設定する）。

   ```sh
   curl -sS -H 'Authorization: Bearer <件数確認トークン>' \
     https://paab.<サブドメイン>.workers.dev/unread
   ```

   正常時の応答は HTTP `200`、`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store` で、未読件数だけを含む JSON を返す。

   ```json
   {"unread": 3}
   ```

   - `GET /unread` は読み取り専用であり、`received_at` を更新しない。何度呼び出しても受信箱の未読メッセージは消費されず、後続の `check_inbox` でそのまま受け取れる（期限切れになった未回答の質問は件数から除外される）。
   - 認証失敗（トークン未指定・不正・失効済み・別用途トークン）は監査ログに `auth_failed` を残して HTTP `401` を返す。対象エージェントが `suspended` のときは `sender_suspended` を残して HTTP `403` を返す。`GET` 以外のメソッド（`POST`、`HEAD` など）は `Allow: GET` 付きの HTTP `405` を返す。

### 定期確認スクリプトの導入（`examples/poll-unread/`）

`GET /unread` をエージェントの VM から定期確認し、未読が 1 件以上あるときにエージェントを起こす見本スクリプトを `examples/poll-unread/` に置いている（POSIX `sh` と `curl` のみで動作する。詳細は `examples/poll-unread/README.md` を参照）。

- **`examples/poll-unread/poll-unread.sh`**: `GET /unread` を呼び出し、未読が 1 件以上あるときに起動スクリプトを実行する（前回と同じ件数や減った件数でも起動する）。状態ファイル（既定は `${XDG_STATE_HOME:-~/.local/state}/paab/unread-count`）に `<前回確認時の未読件数> <最後に起動した UNIX 時刻（秒）>` を保存し、未読が `0` 件のときは `0 0` にリセットする。短い確認間隔で連続起動を抑えたい場合は `PAAB_WAKE_COOLDOWN_SECONDS`（0 以上の整数、既定 `0`）を指定する。起動スクリプトには現在件数と前回確認時の件数（`PAAB_UNREAD_COUNT`・`PAAB_PREV_UNREAD_COUNT` および `$1`・`$2`）を渡す。トークンは `curl --config -` の標準入力で渡すため `ps` に露出せず、通信失敗や不正応答、起動スクリプトの失敗時は状態ファイルを更新せずに終了コード `1` で終わる。
- **`examples/poll-unread/wake.sh`**: 既定の起動ハンドラの見本。`poll-unread.sh` 本体を編集せずに製品ごとの起動処理へ差し替えるには、実行可能（`chmod 755`）なスクリプトを用意して環境変数 `PAAB_WAKE_SCRIPT` に指定する。
- **`examples/poll-unread/crontab.example`**: 5 分間隔（`*/5 * * * *`）で `poll-unread.sh` を動かす crontab の見本。

1. `/admin/agents` で発行した件数確認トークン（`unread_count`）を `chmod 600` のファイルへ保存する（スクリプトや crontab に平文トークンを直書きしない）。

   ```sh
   mkdir -p "$HOME/.config/paab"
   umask 077
   printf '%s\n' '<件数確認トークン>' > "$HOME/.config/paab/unread-token"
   chmod 600 "$HOME/.config/paab/unread-token"
   ```

2. 手元で動作確認する（独自の起動処理を使う場合は `PAAB_WAKE_SCRIPT` を指定する）。

   ```sh
   PAAB_URL="https://paab.<サブドメイン>.workers.dev" \
   PAAB_UNREAD_TOKEN_FILE="$HOME/.config/paab/unread-token" \
   PAAB_WAKE_SCRIPT="/path/to/your-wake.sh" \
   ./examples/poll-unread/poll-unread.sh
   ```

3. `examples/poll-unread/crontab.example` を参考に、`crontab -e` で 5 分ごとの実行を登録する。

### 新着通知 Webhook の設定（`/admin/agents`）

インバウンド Webhook に対応したエージェント（Grok Bot、Manus・Cue、自前レシーバ等）では、新着時に登録済み URL へ HTTP `POST` を送って即座に起動できる（[設計書 2.3 節](design.md#23-規則)・[起動設計 4.1・4.2 節](agent-trigger-design.md#41-通知の不変条件と発火契機確定提案)）。Webhook の登録・変更・鍵ローテーション・削除は `/admin/agents` から利用者本人だけが行え、`/mcp` や `/mcp/admin` からは操作できない。

1. **送信仕様と不変条件**
   - 送信ボディは常に固定 JSON `{"event":"inbox_wake"}` のみ（`Content-Type: application/json`）。質問文・回答文・送信元名・カテゴリ・メッセージ ID は一切含めない。レシーバ側は起動後に `check_inbox` を呼んで新着を受け取る。
   - 宛先が `suspended` 状態のときは送信せず、保留中の配達レコードも破棄する。同一エージェントへの連続新着は保留中 1 件へ集約（coalesce）する。
   - 発火契機は 4 箇所：`ask` 許可時（宛先へ `ctx.waitUntil` で即時送信）、`ask` 拒否時（質問元へ 60 秒遅延で送信。応答時刻差による拒否理由の判別を防ぐ）、`answer` で回答・拒否時（質問元へ即時送信）、定期実行での質問期限切れ時（質問元へ定期実行内で送信）。
   - **SSRF 防御**: `https://` のみ許可（ローカル試験で `WEBHOOK_ALLOW_INSECURE_LOCALHOST="true"` を設定した場合のみ `http://localhost`・`http://127.0.0.1`・`http://[::1]` を例外許可）、URL 最大 2048 文字、ユーザー名・パスワード付き URL 拒否、`localhost`・`*.localhost`・`*.local`・`*.internal`・`*.home.arpa`・単一ラベルホスト名拒否、プライベート・ループバック・リンクローカル・CGNAT・文書用・マルチキャスト・予約済み IPv4 / IPv6 および IPv4 射影 IPv6（`::ffff:...`）拒否、`redirect: "manual"` による 3xx リダイレクト拒否、5 秒タイムアウトを適用する。
   - **再試行方針**: 失敗時（3xx・4xx・5xx・ネットワークエラー・タイムアウト）は最大 3 回（遅延 0 秒・60 秒・300 秒）まで再試行する。3 回失敗すると状態を `abandoned` にして監査ログへ `webhook_abandoned`（理由 `webhook_delivery_failed`）を記録する。送信失敗してもメッセージ本体は D1 の受信箱にそのまま残り、`check_inbox` や `GET /unread` で受け取れる。エラー記録や監査ログ・`change_log` にはシークレットを含めない。

2. **4 つの認証方式（`auth_mode`）とレシーバ側の検証手順**
   `/admin/agents` の各エージェントカードにある「呼び出し先URL（Webhook）」から、受け手に応じた `auth_mode` を選んで登録する。

   - **`standard_webhooks`（Grok Bot 等・Standard Webhooks 準拠レシーバ）**
     - 受け手側が発行した `whsec_<base64>` 鍵（Base64 デコード後 16 バイト以上）を登録する（登録後は再表示されない）。
     - 送信ヘッダー: `webhook-id`（配達 UUID）、`webhook-timestamp`（UNIX 秒）、`webhook-signature`（`v1,<base64>`）。
     - 検証手順: `webhook-timestamp` が現在時刻の許容範囲内（例: ±5 分）であることを確認し、`whsec_` を除いて Base64 デコードした鍵で `${webhook-id}.${webhook-timestamp}.${raw_body}` の HMAC-SHA256 を計算し、Base64 エンコード結果が `webhook-signature` の `v1,` 以降と定数時間比較で一致することを確かめる。
   - **`bearer_header`（Manus・Cue Webhook Trigger 等）**
     - 受け手側が発行したシークレットトークンを登録する（登録後は再表示されない）。
     - 送信ヘッダー: `Authorization: Bearer <secret>`。
     - 検証手順: `Authorization` ヘッダーが `Bearer ` で始まり、続く値が登録済みトークンと定数時間比較で一致することを確かめる。
   - **`custom_header`（任意ヘッダー認証の Webhook Trigger や外部アダプタ）**
     - 受け手側が指定するヘッダー名（英数字とハイフンのみ、1〜64 文字、`Host`・`Content-Length`・`Content-Type`・`Connection`・`Transfer-Encoding`・`Origin`・`Cookie`・`User-Agent` や `cf-*`・`x-forwarded-*`・`sec-*`・`proxy-*` 等の禁止ヘッダー不可）とシークレット値を登録する（登録後は再表示されない）。
     - 送信ヘッダー: `<header_name>: <secret>`。
     - 検証手順: 指定したヘッダーの値が登録済みシークレットと定数時間比較で一致することを確かめる。
   - **`paab_hmac`（自前レシーバ向け・paab 自動生成鍵）**
     - 初回設定時・他方式からの切替時・ローテーション時に paab が `paab_whsec_<64 hex>` 鍵を自動生成し、画面に**一度だけ**表示する（`Cache-Control: no-store`）。
     - 送信ヘッダー: `X-Paab-Timestamp`（UNIX 秒）、`X-Paab-Signature`（`sha256=<64 hex>`）。
     - 検証手順: `X-Paab-Timestamp` が許容範囲内（例: ±5 分）であることを確認し、鍵文字列（`paab_whsec_...` 全体）の UTF-8 バイト列を鍵として `${X-Paab-Timestamp}.${raw_body}` の HMAC-SHA256 を計算し、小文字 16 進数文字列が `X-Paab-Signature` の `sha256=` 以降と定数時間比較で一致することを確かめる。

   外部認証方式で同じ `auth_mode` のまま URL だけを変更したい場合は、シークレット欄を空欄で保存すると既存のシークレットが維持される。`paab_hmac` の鍵を差し替えたい場合は「署名鍵をローテーション」を実行する。

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

デプロイされた Worker は、`triggers.crons` の 2 つのスケジュールで定期実行を行う。

- **`* * * * *`（毎分）**: 保留中 Webhook 配達のみを実行する（送信予定時刻に達した配達・再試行・拒否質問の 60 秒遅延通知の送信、および `suspended` 状態または未設定エージェントの保留中配達の破棄）。`messages`・`audit_log`・`proposals` にはアクセスしない。
- **`0 * * * *`（1 時間ごと）**: 定期メンテナンス一式を実行する。各処理は互いに障害分離されており、1 つが失敗しても他の処理は継続する。内容は次のとおり。
  - 期限切れになった質問を期限切れとして処理し、監査ログへ記録して質問元エージェントへの通知（Webhook）を登録すること。
  - 受け取りから 24 時間を過ぎたメッセージ本文および一度も受け取られずに期限切れになった質問の本文を消すこと（設計書 4 節）。
  - 保持期間を過ぎた監査ログの本文を消すこと。
  - 期限切れになった管理者ボットからの提案を `expired` にすること。
  - 送信予定時刻に達した保留中 Webhook 配達を実行し、`suspended` 状態または未設定エージェントの保留中配達を破棄すること。

ローカルでは定期実行は自動で動かない。ローカルでの確かめ方は「2つのクライアントで質問応答を試す」の「期限切れ」を参照（`/cdn-cgi/local/scheduled` は 1 時間ごとの定期メンテナンス一式を実行する）。

## 依存と Actions の更新

- npm の依存と GitHub Actions の更新は Dependabot が週1回 PR にする。Actions はコミットで固定しているため、更新 PR が新しいコミットを指す。
- CI は `npm audit --omit=dev --audit-level=high` を含む。本番依存に high 以上の脆弱性が見つかると CI が落ちるので、更新 PR で直す。
- `wrangler.jsonc` の `compatibility_date` は、wrangler を更新するときに一緒に進める。進める前に `npm run check` と `npm run dev` での起動を確かめ、変更は単独のコミットにする。

## 補足

- 対応プラン: Workers Free で動く。`db.batch` の1回が Workers Free の上限（1呼び出しあたり50クエリ）に対して1回と数えられる前提では、`check_inbox` が使う D1 呼び出し回数は受け取るメッセージ数に依らずほぼ一定である（監査ログへの書き込みは25件ずつ `db.batch` でまとめる）。定期実行は期限切れにする質問25件あたり約3回ずつ増えるため、未回答のまま同時に期限切れになる質問が約375件を超えない限り上限に達しない（`db.batch` が文ごとに数えられるかどうかは Cloudflare の公式文書に明記がなく未確認）。
- コマンドは `scripts/paab.ts` を esbuild でまとめてから Node で実行する。まとめた結果は `.wrangler/tmp/paab-cli.mjs` に置かれる。
- ローカルのD1の保存先を変えるには `--persist-to <ディレクトリ>` を付ける（`--local` のときだけ）。`wrangler dev` にも同じ値を渡す。
- 本番向け（`--remote`）の管理コマンドは既定で `wrangler.local.jsonc` を使う。別の設定ファイルを使う場合は `--config <パス>` を付ける。
