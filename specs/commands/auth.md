# `backcourt-duo auth`

エージェント（Claude または OpenCode）と GitHub の認証状態を確認し、必要ならサインインする。
backcourt-duo 自身は認証情報を保存しない。**既存のツール（Claude Code・OpenCode・gh）が持っている認証をそのまま使う**のが基本方針である。

## バックエンドの選択

`--agent claude|opencode` で対象を選ぶ。省略したときは保存されている `agent.backend`（既定 `claude`）に従う。
`--claude` を付けると設定にかかわらず Claude を対象にする（specs/sessions/agent-opencode.md#バックエンドの選択）。

## `backcourt-duo auth status [--json] [--agent <name>] [--auth <mode>] [--show-account]`

次の内容を表示する。

```
Agent (Claude)
  mode:      claude-code            ← 実際に使うモード（--auth / BACKCOURT_DUO_AUTH / デフォルト）
  status:    signed in (claude.ai, pro)  ← メールアドレスはデフォルトで出さない
  binary:    /home/me/.local/bin/claude (2.1.x)
  note:      ANTHROPIC_API_KEY is set but ignored in claude-code mode
GitHub
  source:    gh (github.com, account: octocat)
  scopes:    repo
```

- 見出しは `Agent (Claude)` または `Agent (OpenCode)`
- claude-code モードの状態は `claude auth status --json` の結果から作る（specs/sessions/agent-claude-code.md）
- api-key モードでは環境変数があるかどうかだけを表示する。値は先頭 7 文字と末尾 4 文字だけを残してマスクする
- OpenCode のときは `opencode models --standalone` が通るかで ready を判定し、バイナリとモデル数を表示する。
  認証情報は OpenCode 側にあり、backcourt-duo は読まない
- Claude アカウントのメールアドレスは `privacy.account`（`BACKCOURT_DUO_ACCOUNT`）に従う。デフォルトは非表示。
  `--show-account` を付けると、その実行だけ設定にかかわらずそのまま表示する（specs/sessions/agent-claude-code.md#アカウントの表示）
- `--json` は機械可読な形で出力する（`{ backend, agent: AgentAuthSummary, github: GitHubAuthSummary }`）
- 終了コード: 両方使える → 0、エージェントだけ使えない → 10、GitHub だけ使えない → 11、両方使えない → 12

## `backcourt-duo auth login [--claude | --github] [--console]`

- `--github`: `gh auth login` を stdio 継承で実行する。gh がなければ `GH_TOKEN` の設定方法を案内する
- それ以外は、選択中のバックエンド（`--agent` > 保存値 > claude。`--claude` で Claude 固定）に従う
- Claude のとき、`--claude`（何も指定しないときのデフォルト）は `claude auth login --claudeai` を stdio 継承で実行し、
  **Claude のサブスクリプション（Pro/Max/Team/Enterprise）でサインイン**する
  - `--console` を付けると `claude auth login --console`（Anthropic Console のアカウント、API 従量課金）になる
  - `claude` が PATH にない場合は、インストール方法（`npm i -g @anthropic-ai/claude-code` など）を案内して exit 1
- OpenCode のときは `opencode auth login` を stdio 継承で実行する。`opencode` がなければインストール方法と
  `BACKCOURT_DUO_OPENCODE_PATH` を案内して exit 1

## `backcourt-duo auth logout [--agent <name>]`

選択中のバックエンド（`--agent` > 保存値 > claude。`--claude` で Claude 固定）からログアウトする。
本体のログアウトになるので、実行前に確認を求める（`--yes` で確認を省略できる）。

- Claude: `claude auth logout`
- OpenCode: `opencode auth logout`
- GitHub のログアウトは提供しない（gh 側で行う）
