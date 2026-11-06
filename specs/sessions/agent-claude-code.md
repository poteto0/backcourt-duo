# エージェント認証: `claude-code`（デフォルト）

ローカルの **Claude Code のサインイン状態を引き継いで**エージェントを動かすモード。
ユーザーがすでに `claude` にサブスクリプション（claude.ai: Pro / Max / Team / Enterprise）か Console アカウントでログインしていれば、追加の設定なしで動く。
backcourt-duo はトークンを読まないし、保存もしない。認証の処理はすべて Claude Code に任せる。

## 仕組み

- エージェントは `@anthropic-ai/claude-agent-sdk` の `query()` で起動する。SDK は Claude Code のプロセスを子プロセスとして立ち上げ、
  その子プロセスは通常の Claude Code と同じ設定ディレクトリ（`CLAUDE_CONFIG_DIR`、デフォルトは `~/.claude`）とキーチェーンから認証情報を読む
- そのため、使う実行ファイルはユーザーがログインに使った `claude` と揃える。解決の順番は次のとおり
  1. `BACKCOURT_DUO_CLAUDE_PATH`
  2. PATH 上の `claude`
  3. 見つからなければ SDK に同梱されている実行ファイル（`pathToClaudeCodeExecutable` を指定しない）
- 同梱の実行ファイル（`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`、1 つ約 320MB）は、このリポジトリの lockfile では
  `pnpm-workspace.yaml` の `ignoredOptionalDependencies` で除外している。Nix の `fetchPnpmDeps` が全プラットフォーム分を取得し、
  初回ビルドが非常に遅くなるため（#36）。したがって、ソースからのビルドと Nix パッケージでは 3 は存在せず、`claude` が必須になる。
  npm からインストールした場合は同梱の実行ファイルが入る
- 子プロセスの環境変数からは `ANTHROPIC_API_KEY` と `ANTHROPIC_AUTH_TOKEN` を**取り除く**。
  これらが残っていると、Claude Code はサブスクリプションより API キーを優先してしまうためである（いわゆる「キーがサインインを隠す」問題）。
  取り除いた場合は `warnings` に「ANTHROPIC_API_KEY is set but ignored in claude-code mode」を追加する
- `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` などのプロバイダ設定は Claude Code 側の設定として尊重し、そのまま渡す
- User-Agent を識別できるように `CLAUDE_AGENT_SDK_CLIENT_APP=backcourt-duo/<version>` を設定する

## 状態の確認

`claude auth status --json` を実行する（タイムアウトは 10 秒）。

| 結果 | `AgentAuthSummary` |
|---|---|
| `loggedIn: true` | `ready: true`, `method: authMethod`, `account: 表示ポリシーに従って変換した email`（下記）, `subscription: subscriptionType` |
| `loggedIn: false` | `ready: false`, `hint: 'Sign in with Claude (subscription)'` |
| `claude` が PATH にない | 同梱の実行ファイルで起動を試み、最初のメッセージで認証エラーが返れば `ready: false` にする。`hint` でインストールとログインを案内する |
| コマンドが失敗した | `ready: false`, `hint` に stderr の 1 行目を入れる |

エージェントの実行中に認証エラー（`SDKAuthStatusMessage`、またはエラー文字列に `authentication` / `login` / `401` を含む結果）を受け取った場合は、
`agent.status = 'signed-out'` にして UI にサインインを促す。

## アカウントの表示

Claude アカウントのメールアドレスは画面共有・配信・スクリーンショットで漏れやすいので、**デフォルトでは出さない**。
表示方法は `BACKCOURT_DUO_ACCOUNT` > `~/.backcourt-duo/config.json` の `privacy.account` > `hide` の順で決まる（specs/commands/start.md#設定ファイル）。

| 値 | `AgentAuthSummary.account` | 表示の例 |
|---|---|---|
| `hide`（デフォルト） | 入れない | `claude-code · pro` |
| `mask` | 先頭 1 文字とドメインだけ残す | `a***@example.com` |
| `show` | そのまま | `alice@example.com` |

- 変換は `src/server/auth/agent.ts` で `AgentAuthSummary` を作るときに 1 回だけ行う。
  `hide` / `mask` のときは生のメールアドレスがサーバーのメモリ上の summary にも入らないので、
  SSE、永続化ファイル（チャット中の「Signed in as …」を含む）、エージェントのコンテキスト、ターミナル出力のどこにも流れない。UI 側で隠す実装にはしない
- UI のチャットヘッダー、サインイン時のシステムメッセージ、`start` の `agent` 行、`doctor` の `agent-auth`、`auth status` はすべてこの値を表示する
- 本人確認したいときは `backcourt-duo auth status --show-account`（その実行だけ `show` として扱う）
- GitHub のログイン名（`login`）は公開情報なので対象外

## サインイン（サブスク）

- CLI: `backcourt-duo auth login`（内部で `claude auth login --claudeai` を実行する）
- UI: `agent.status === 'signed-out'` のときにチャットペインに **Sign in with Claude** ボタンを表示する
  - 押すと `POST /api/auth/claude/login` が送られ、サーバーが `claude auth login --claudeai` を起動する。ブラウザで claude.ai の認可ページが開く
  - サーバーはプロセスの終了を待ってから `claude auth status --json` をもう一度確認し、`ready` になればエージェントセッションを自動で再起動する
  - 同時に実行できるログインプロセスは 1 つまで。実行中にもう一度押されたら 409 を返す
  - ログインプロセスの stdout / stderr は UI に送らない（URL やコードが含まれうるため）。終了コードだけを返す
- サインアウトは提供しない（`backcourt-duo auth logout --claude` は確認のうえ Claude Code 本体のログアウトに委譲する）

## 利用条件についての注意

このモードはユーザー本人が自分のマシンで、自分の Claude Code のサインインを使うためのものである。
backcourt-duo 自体が claude.ai ログインを第三者向けのサービスとして提供することはしない（リモートに公開しない。local-server.md を参照）。
