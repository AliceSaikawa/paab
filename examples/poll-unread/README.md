# `poll-unread` — 未読件数の定期確認サンプル

paab の `GET /unread` を定期的に確認し、未読が 1 件以上あるときにエージェント起動スクリプト（`wake.sh`）を実行するための POSIX シェルスクリプト見本である。

- AI の利用枠や MCP 接続を消費せずに新着を検知する。
- 件数確認トークン（`unread_count`）は `curl --config -` の標準入力経由で渡すため、`ps` のコマンドライン引数に露出しない。
- ネットワーク障害、HTTP 200 以外の応答、不正な JSON、または起動スクリプトの失敗時は状態ファイルを更新せず終了コード `1` で終了するため、次回の cron 実行で自動的に再試行される。

## 前提条件

- POSIX `sh`（`/bin/sh`）
- `curl`
- 標準 POSIX ユーティリティ（`awk`、`date`、`sed`、`tr`、`wc`、`dirname`、`basename`、`mkdir`、`mv`、`rm`）

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

`poll-unread.sh` は未読件数が 1 件以上のとき（前回の件数と同じか減った場合も含む）に、次の引数と環境変数を渡して `PAAB_WAKE_SCRIPT` を呼ぶ。

- 引数: `$1` = 現在の未読件数、`$2` = 前回確認時の未読件数（初回または未読 0 件後は `0`）
- 環境変数: `PAAB_UNREAD_COUNT`、`PAAB_PREV_UNREAD_COUNT`

状態ファイル（`PAAB_STATE_FILE`）には `<前回確認時の未読件数> <最後に起動した UNIX 時刻（秒）>` を 1 行で保存する。

- 起動スクリプトが終了コード `0` を返したときだけ状態ファイルを更新する。失敗時は状態ファイルを更新せず終了コード `1` で終わるため、次回の確認で即座に再試行される。
- 未読が `0` 件のときは起動せず、状態ファイルを `0 0` にリセットする。
- 短い間隔で確認し連続起動を抑えたい場合は `PAAB_WAKE_COOLDOWN_SECONDS` に正の整数（秒）を指定する。前回の起動から指定秒数が経つまでは再起動を抑制し、経過後または一度未読が `0` 件に戻った後の新着で再び起動する（既定は `0` 秒で抑制しない）。

## 3. 手動で動作確認する

```sh
PAAB_URL="https://paab.<サブドメイン>.workers.dev" \
PAAB_UNREAD_TOKEN_FILE="$HOME/.config/paab/unread-token" \
./examples/poll-unread/poll-unread.sh
```

未読が 1 件以上ある状態で実行すると `wake.sh` の出力が表示され、未読が 0 件のときは何も出力されず終了コード `0` で終わる。`PAAB_WAKE_COOLDOWN_SECONDS` に正の秒数を指定した場合は、その秒数が経過する前の再実行では出力せず終了コード `0` で終わる。

## 4. cron に 5 分間隔で登録する

`crontab.example` を参考に、`crontab -e` で 5 分間隔（`*/5 * * * *`）のジョブを登録する。

```cron
*/5 * * * * PAAB_URL="https://paab.<サブドメイン>.workers.dev" PAAB_UNREAD_TOKEN_FILE="$HOME/.config/paab/unread-token" /path/to/paab/examples/poll-unread/poll-unread.sh
```

独自の起動スクリプトを使う場合は、同じ行に `PAAB_WAKE_SCRIPT="/path/to/your-wake.sh"` を追加する。短い間隔で確認し連続起動を抑えたい場合は `PAAB_WAKE_COOLDOWN_SECONDS="300"` のようにクールダウン秒数を追加する。

## 環境変数

| 変数 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `PAAB_URL` | 必須 | なし | paab のベース URL（末尾の `/` は自動で除去される） |
| `PAAB_UNREAD_TOKEN_FILE` | いずれか必須 | なし | 件数確認トークンを保存したファイル（`chmod 600` 推奨）。`PAAB_UNREAD_TOKEN` が未設定・空のときに読み込む |
| `PAAB_UNREAD_TOKEN` | いずれか必須 | なし | 件数確認トークンの文字列（通常はファイル経由の `PAAB_UNREAD_TOKEN_FILE` を推奨） |
| `PAAB_STATE_FILE` | 任意 | `${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/paab/unread-count` | 前回確認時の未読件数と最後に起動した UNIX 時刻（秒）を `<件数> <時刻>` 形式で保存するファイル（未読 0 件時は `0 0`） |
| `PAAB_WAKE_SCRIPT` | 任意 | `poll-unread.sh` と同じディレクトリの `wake.sh` | 未読が 1 件以上あるときに実行する実行可能ファイル |
| `PAAB_WAKE_COOLDOWN_SECONDS` | 任意 | `0` | 再起動を抑制するクールダウン秒数（0 以上の整数。`0` は抑制なし。未読が `0` 件になるとリセットされる） |
| `PAAB_CURL_TIMEOUT` | 任意 | `10` | `curl` のタイムアウト秒数（正の整数） |
