# paab 作業ルール

paab（Personal SI Agent Bridge）の設計は [docs/design.md](docs/design.md) にある。実装前に必ず読むこと。設計書と食い違う実装が必要になった場合は、実装せずに統合担当へ報告する。

## Git ワークフロー

複数のエージェントが同時に実装するため、全員が次の手順に従う。

### ブランチ

- `main` は常に動く状態を保つ。`main` へ直接コミットしない。
- 1タスク＝1ブランチ＝1 worktree。他のタスクのブランチや worktree では作業しない。
- ブランチは最新の `main` から切る。
- ブランチ名は `<種別>/<エージェント名>/<対象>`。英小文字、数字、ハイフンを使う。例：`feat/agent-1/ask-tool`、`fix/lead/inbox-expiry`。
  - 種別は、下の「コミット」で挙げる Conventional Commits の種別と同じ語を使う。
  - エージェント名は、そのブランチで作業するエージェントの名前（`lead`、`agent-1` など）。利用者本人が作業する場合は `user`。
  - 対象は、何を作る・直すかを短く表す。

### コミット

[Conventional Commits 1.0.0](https://www.conventionalcommits.org/ja/v1.0.0/) に従う。

```
<種別>[(<範囲>)][!]: <要約>

[本文]

[フッター]
```

- 種別は次のいずれか。

  | 種別 | 用途 |
  | --- | --- |
  | `feat` | 機能の追加 |
  | `fix` | 不具合の修正 |
  | `docs` | 文書だけの変更 |
  | `style` | 挙動に影響しない書式の変更 |
  | `refactor` | 挙動を変えないコードの整理 |
  | `perf` | 性能の改善 |
  | `test` | テストの追加・修正 |
  | `build` | ビルドの仕組みや依存関係の変更 |
  | `ci` | CI の設定の変更 |
  | `chore` | 上のどれにも当たらない雑務 |
  | `revert` | 以前のコミットの取り消し |

- 範囲は変更した領域を表す名詞で、省略できる。例：`inbox`、`policy`、`admin`。
- コミットメッセージは、要約・本文・フッターとも英語で書く。
- 要約は何を変えたかを命令形で一文に書く。小文字で始め、末尾にピリオドを付けない。例：`feat(inbox): expire unanswered questions after 7 days`。
- 理由や注意点があれば、空行を挟んで本文に書く。
- 互換性を壊す変更は、種別（と範囲）の直後に `!` を付け、フッターに `BREAKING CHANGE: <説明>` を書く。
- 1コミットには1つの目的だけを入れる。無関係な整形や整理を混ぜない。
- 秘密の値（トークン、`.dev.vars`、`.env`）をコミットしない。

### 書き込み範囲

- タスクには、変更してよいファイルやディレクトリの範囲が割り当てられる。範囲外の変更が必要になったら、変更せずに統合担当へ報告する。
- 複数のタスクが触れやすい共有ファイル（`package.json`、ロックファイル、`wrangler` の設定、データベースのマイグレーション、共通の型定義）は、そのタスクに明示的に割り当てられた場合だけ変更する。

### 統合

- `main` への取り込みは統合担当（ルートのエージェント、または利用者）だけが行う。作業担当は自分のブランチへのコミットまでで止める。
- 作業担当は、引き渡す前に自分のブランチを最新の `main` にリベースし、検証を通す。
- 取り込みはスカッシュマージで行う。`main` の履歴は「1タスク＝1コミット」の一直線にする。スカッシュ後のコミットメッセージも Conventional Commits に従い、英語で書く。
- PR を作る場合、タイトルは英語で、コミットの要約と同じ Conventional Commits の形式で書く。例：`feat(inbox): expire unanswered questions after 7 days`。スカッシュマージでは、このタイトルをそのままコミットの要約に使う。
- PR の本文は日本語で書く。変更内容、実行した検証と結果、残課題を書く。
- スカッシュ後のコミットの本文には、そのブランチに含まれる各コミットのメッセージを、古い順に `* ` 始まりの箇条書きで並べる。各コミットに本文があれば、要約の下に空行を挟んで続ける。日本語の PR 本文は貼らない。

  ```
  feat(inbox): expire unanswered questions after 7 days (#12)

  * feat(inbox): add expiry timestamp to questions

  Questions now record when they expire so that the sweep can select
  them without recomputing the deadline.

  * feat(inbox): sweep expired questions on a schedule

  * test(inbox): cover expiry at the 7 day boundary
  ```

  - GitHub の画面からスカッシュマージすると、要約の末尾に PR 番号 `(#12)` が付き、本文にこの形の一覧が入る。そのまま使う。
  - PR を作らずローカルで `git merge --squash` する場合も、同じ形の本文を書く。PR 番号は付けない。
  - 本文がそのまま `main` に残るため、ブランチ内の各コミットも上の「コミット」の規約どおりに書く。`wip` や `fix typo` のようなコミットは、引き渡し前にまとめる。
- 取り込み後、そのブランチと worktree は統合担当が削除する。
- `main` の履歴を書き換えない。強制プッシュをしない。
- リモートへのプッシュ、PRの作成、デプロイは、利用者の明示的な許可がある場合だけ行う。

### 引き渡し時の報告

作業担当は、次の3点を統合担当へ報告する。

- 変更内容（ブランチ名を含む）。
- 実行した検証とその結果。実行していない検証はそう書く。
- 残っている課題と、設計書・このファイルとの食い違い。

## 検証

ローカルでは次を実行する。依存のインストールからまとめて通すには `npm ci && npm run check` を使う。

- **Node** は `>=22.12.0`（`wrangler` の要求に合わせる）。
- **npm** は `>=11.12.1`。npm 10 や 11.11 未満では依存解決が失敗する。Node 24 付属の npm 11.19 系で通る。

`typecheck` は先に `wrangler types` を実行し、git 管理外の `worker-configuration.d.ts` を生成してから `tsc` する。

- `npm run check` — TypeScript の型チェック、Biome の lint、Vitest のテストを順に実行する。
- `npm run dev` — Wrangler でローカル起動する。`GET /health` が 200 を返すことを確認する。
- 個別に実行する場合: `npm run typecheck`、`npm run lint`、`npm run test`、`npm run format`（整形のみ）。

CI では `main` への push と Pull Request で `npm run check` が走る（`.github/workflows/ci.yml`）。
