# `poll-unread` — 未読件数の定期確認サンプル

paab の `GET /unread` を定期的に確認し、前回確認時より未読件数が増えたときだけエージェント起動スクリプト（`wake.sh`）を実行するための POSIX シェルスクリプト見本である。

- AI の利用枠や MCP 接続を消費せずに新着を検知する。
- 件数確認トークン（`unread_count`）は `curl --config -` の標準入力経由で渡すため、`ps` のコマンドライン引数に露出しない。
- ネットワーク障害、HTTP 200 以外の応答、不正な JSON、または起動スクリプトの失敗時は状態ファイルを更新せず終了コード `1` で終了するため、次回の cron 実行で自動的に再試行される。

## 前提条件

- POSIX `sh`（`/bin/sh`）
- `curl`
- 標準 POSIX ユーティリティ（`awk`、`sed`、`tr`、`wc`、`dirname`、`basename`、`mkdir`、`mv`、`rm`）

Node.js や `jq` は不要である。

## 1. 件数確認トークンを配置する

`/admin/agents` から対象エージェントの件数確認トークン（`unread_count`）を発行し、所有者のみ読み取れる権限（`chmod 600`）のファイルに保存する。トークンをスクリプトや crontab に直接書いてはいけない。

```sh
mkdir -p "$HOME/.config/paab"
umask 077
printf '%s\n' '<発行した件数確認トークン>' > "$HOME/.config/paab/unread-token"
chmod 600 "$HOME/.config/paab/unread-token"
```

## 2. 起動処理（`wake.sh`）を差し替える

既定では同じディレクトリの `wake.sh` を実行し、`[paab] new unread messages: <現在件数> (previous: <前回件数>)` を標準出力に出す。

実際の製品に合わせてエージェントを起こす処理を組み込むときは、`poll-unread.sh` 本体を書き換えず、実行権限（`chmod 755`）を付けた任意のスクリプトを用意して環境変数 `PAAB_WAKE_SCRIPT` で指定する。

```sh
export PAAB_WAKE_SCRIPT="/path/to/your-wake.sh"
```

`poll-unread.sh` は未読件数が増えたとき（`現在件数 > 前回件数`）だけ、次の引数と環境変数を渡して `PAAB_WAKE_SCRIPT` を呼ぶ。

- 引数: `$1` = 現在の未読件数、`$2` = 前回の未読件数
- 環境変数: `PAAB_UNREAD_COUNT`、`PAAB_PREV_UNREAD_COUNT`

起動スクリプトが終了コード `0` を返したときだけ状態ファイルが新しい件数へ更新される。未読件数が減ったとき（`check_inbox` 後に `0` へ戻ったときなど）は起動せずに状態ファイルだけを更新するため、次の新着（`0 -> 1`）で再び起動する。

## 3. 手動で動作確認する

```sh
PAAB_URL="https://paab.<サブドメイン>.workers.dev" \
PAAB_UNREAD_TOKEN_FILE="$HOME/.config/paab/unread-token" \
./examples/poll-unread/poll-unread.sh
```

未読が増えた状態で実行すると `wake.sh` の出力が表示され、そのまま同じ件数でもう一度実行すると何も出力されず終了コード `0` で終わる。

## 4. cron に 5 分間隔で登録する

`crontab.example` を参考に、`crontab -e` で 5 分間隔（`*/5 * * * *`）のジョブを登録する。

```cron
*/5 * * * * PAAB_URL="https://paab.<サブドメイン>.workers.dev" PAAB_UNREAD_TOKEN_FILE="$HOME/.config/paab/unread-token" /path/to/paab/examples/poll-unread/poll-unread.sh
```

独自の起動スクリプトを使う場合は、同じ行に `PAAB_WAKE_SCRIPT="/path/to/your-wake.sh"` を追加する。

## 環境変数

| 変数 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `PAAB_URL` | 必須 | なし | paab のベース URL（末尾の `/` は自動で除去される） |
| `PAAB_UNREAD_TOKEN_FILE` | いずれか必須 | なし | 件数確認トークンを保存したファイル（`chmod 600` 推奨）。`PAAB_UNREAD_TOKEN` が未設定・空のときに読み込む |
| `PAAB_UNREAD_TOKEN` | いずれか必須 | なし | 件数確認トークンの文字列（通常はファイル経由の `PAAB_UNREAD_TOKEN_FILE` を推奨） |
| `PAAB_STATE_FILE` | 任意 | `${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/paab/unread-count` | 前回の未読件数を保存するファイル |
| `PAAB_WAKE_SCRIPT` | 任意 | `poll-unread.sh` と同じディレクトリの `wake.sh` | 未読件数が増えたときに実行する実行可能ファイル |
| `PAAB_CURL_TIMEOUT` | 任意 | `10` | `curl` のタイムアウト秒数（正の整数） |
