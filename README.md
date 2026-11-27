# paab

paab（Personal SI Agent Bridge）は、同一人物が使う複数のパーソナルAIエージェントが、互いに質問して回答を得るための中継サーバーである。MCP で接続するエージェント同士の質問と回答を仲介する。Cloudflare Workers と D1 で動き、利用者が各自の Cloudflare アカウントにデプロイして使う（1デプロイ＝1ユーザー）。

- 導入手順と管理コマンド: [docs/setup.md](docs/setup.md)
- 設計書: [docs/design.md](docs/design.md)
- エージェント起動トリガー設計書: [docs/agent-trigger-design.md](docs/agent-trigger-design.md)

ライセンスは MIT（[LICENSE](LICENSE)）。
