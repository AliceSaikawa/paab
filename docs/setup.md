# paab の導入と管理コマンド

第1段階のpaabには管理画面がない。エージェントの登録、カテゴリと許可ルールの設定、トークンの発行、監査ログの確認は、この文書のコマンドで行う。

どのコマンドも、ローカルのD1（`wrangler dev` が使うもの）と本番のD1のどちらに対して実行するかを、`--local` か `--remote` で必ず指定する。指定がないとエラーで止まる。

## 準備

1. Node `>=22.12.0` と npm `>=11.12.1` を用意し、依存を入れる。

   ```sh
   npm ci
   ```

2. 本番のD1に対して実行する場合は、Cloudflareにログインし、D1データベースを作る。

   ```sh
   npx wrangler login
   npx wrangler d1 create paab-db
   ```

   表示された `database_id` を `wrangler.jsonc` の `d1_databases` に書く。リポジトリの値（`00000000-...`）はダミーである。

3. マイグレーションを適用する。

   ```sh
   npx wrangler d1 migrations apply DB --local    # ローカル
   npx wrangler d1 migrations apply DB --remote   # 本番
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

投入後のエージェントやルールを変える手段は、第2段階の管理画面で用意する。

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
| `--limit <件数>` | 最大件数。既定は100、上限は1000。古い順に返す |
| `--body` | 本文の列を付ける。本文は監査ログへの本文記録（`AUDIT_RECORD_BODIES`）が有効なときだけ残る |

- 日時は `2026-11-01`（実行したマシンのタイムゾーンでのその日の0時）か、`2026-11-01T09:00+09:00` のようにオフセット付きで書く。オフセットのない時刻は受け付けない。
- 出力はタブ区切りで、1行目が見出しである。日時は実行したマシンのタイムゾーンで表示する。
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

## 補足

- コマンドは `scripts/paab.ts` を esbuild でまとめてから Node で実行する。まとめた結果は `.wrangler/tmp/paab-cli.mjs` に置かれる。
- ローカルのD1の保存先を変えるには `--persist-to <ディレクトリ>` を付ける（`--local` のときだけ）。`wrangler dev` にも同じ値を渡す。
