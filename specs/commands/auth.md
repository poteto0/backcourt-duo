# `backcourt-duo auth`

エージェント（Claude）と GitHub の認証状態を確認し、必要ならサインインする。
backcourt-duo 自身は認証情報を保存しない。**既存のツール（Claude Code と gh）が持っている認証をそのまま使う**のが基本方針である。

## `backcourt-duo auth status [--json] [--auth <mode>]`

次の内容を表示する。

```
Agent (Claude)
  mode:      claude-code            ← 実際に使うモード（--auth / BACKCOURT_DUO_AUTH / デフォルト）
  status:    signed in (claude.ai, pro)  you@example.com
  binary:    /home/me/.local/bin/claude (2.1.x)
  note:      ANTHROPIC_API_KEY is set but ignored in claude-code mode
GitHub
  source:    gh (github.com, account: octocat)
  scopes:    repo
```

- claude-code モードの状態は `claude auth status --json` の結果から作る（specs/sessions/agent-claude-code.md）
- api-key モードでは環境変数があるかどうかだけを表示する。値は先頭 7 文字と末尾 4 文字だけを残してマスクする
- `--json` は機械可読な形で出力する（`{ agent: AgentAuthSummary, github: GitHubAuthSummary }`）
- 終了コード: 両方使える → 0、エージェントだけ使えない → 10、GitHub だけ使えない → 11、両方使えない → 12

## `backcourt-duo auth login [--claude | --github] [--console]`

- `--claude`（何も指定しないときのデフォルト）: `claude auth login --claudeai` を stdio 継承で実行し、**Claude のサブスクリプション（Pro/Max/Team/Enterprise）でサインイン**する
  - `--console` を付けると `claude auth login --console`（Anthropic Console のアカウント、API 従量課金）になる
  - `claude` が PATH にない場合は、インストール方法（`npm i -g @anthropic-ai/claude-code` など）を案内して exit 1
- `--github`: `gh auth login` を stdio 継承で実行する。gh がなければ `GH_TOKEN` の設定方法を案内する

## `backcourt-duo auth logout --claude`

`claude auth logout` に委譲する。Claude Code 本体のログアウトになるので、実行前に確認を求める（`--yes` で確認を省略できる）。
GitHub のログアウトは提供しない（gh 側で行う）。
