# エージェント認証: `api-key`

`--auth api-key` または `BACKCOURT_DUO_AUTH=api-key` で有効になる。
CI に近い環境や、サブスクではなく API の従量課金で使いたいときのためのモード。

## 認証情報の探し方

優先順位は次のとおり。

1. `BACKCOURT_DUO_ANTHROPIC_API_KEY`（backcourt-duo 専用。グローバルの環境変数を汚したくないとき用）
2. `ANTHROPIC_API_KEY`
3. `ANTHROPIC_AUTH_TOKEN`（Bearer トークン、ゲートウェイ経由など）

どれもなければ `ready: false` とし、`hint: 'Set ANTHROPIC_API_KEY (or use --auth claude-code)'` を返す。
`ANTHROPIC_BASE_URL` が設定されていればそのまま渡す（プロキシやゲートウェイ用）。

## 実行ファイル

このモードでもエージェントは Claude Code の子プロセスとして動く。実行ファイルは agent-claude-code.md と同じ順番（`BACKCOURT_DUO_CLAUDE_PATH` → PATH 上の `claude` → SDK に同梱の実行ファイル）で探す。
キーはあるのにどれも見つからない場合（同梱の実行ファイルが除外されたソースビルドや Nix パッケージで、`claude` が入っていないとき）は、
`ready: false` とし、`hint` で Claude Code のインストールか `BACKCOURT_DUO_CLAUDE_PATH` の設定を案内する。

## 子プロセスに渡す環境変数

- `process.env` をコピーし、見つけた値を `ANTHROPIC_API_KEY`（3 の場合は `ANTHROPIC_AUTH_TOKEN`）として設定する
- Claude Code 側のサインインに切り替わらないよう、`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` は削除する
- キーの値はログに出さない。`AgentAuthSummary.method` には変数名だけを入れる（例: `ANTHROPIC_API_KEY`）。`account` にはマスクした値（`sk-ant-…abcd`）を入れる

## 失敗したとき

401 / 403 を受けたら `agent.status = 'error'` にし、`error: 'API key rejected'` を返す。
UI には「キーを確認するか、`--auth claude-code` で起動し直す」よう案内を表示する。キーの値は表示しない。
