# エージェント: OpenCode バックエンド

Claude を既定のまま、レビュー担当を [OpenCode](https://opencode.ai) に差し替えられるようにする（#48）。
どちらのバックエンドでも **状態の正は `ReviewStore`** で、エージェントは MCP ツール経由でそれを読み書きする
（AGENTS.md の原則 1・4）。OpenCode は別プロセスで動くため、Claude の in-process MCP サーバーの代わりに
同じツール定義を HTTP の MCP エンドポイントとして公開する。

## バックエンドの選択

```
--agent <name> > BACKCOURT_DUO_AGENT > 設定ファイルの agent.backend > claude
```

- 値は `claude`（別名 `claude-code`）と `opencode`
- `--agent` を指定すると、その値を `~/.backcourt-duo/config.json` の `agent.backend` に保存する。
  **一度 `--agent opencode` で起動すれば、次回からは指定なしで OpenCode になる**（#48）。Claude に戻すときは `--agent claude`
- 環境変数とリポジトリ設定はバックエンドを変えない（specs/commands/start.md#設定ファイル）
- 実行中に UI からバックエンドを切り替えることはできない。切り替えはプロセスの再起動で行う
- `--agent opencode` のとき `--auth` は無視する（OpenCode 自身の認証を使う）。`--effort` も使わない
  （OpenCode ではモデルのバリアントで表現する。`agent.effort` は Claude 用として保存だけする）

## 認証

backcourt-duo は OpenCode の認証情報を読まない・保存しない。`opencode` が持っている認証をそのまま使う。

- バイナリは `BACKCOURT_DUO_OPENCODE_PATH`、なければ PATH 上の `opencode`
- 起動時に `opencode models --standalone` を実行し、モデル一覧が取れるかで ready を判定する
  - 1 行 1 モデル（`provider/model`）。重複は落とし、最初の `/` で provider とモデル名に分ける
  - 失敗したときは `agent.status = 'signed-out'`、`auth.hint` に OpenCode のエラーを出す
- `backcourt-duo auth status|login|logout --agent opencode` は OpenCode 自身に委譲する
  - `login` / `logout` は `opencode auth login` / `opencode auth logout` を stdio 継承で実行する
  - `logout` は Claude と同じく確認を求める（`--yes` で省略）
  - `--agent` を省いたときは保存されている `agent.backend` に従う（`--claude` を付ければ Claude）
- チャットのサインイン欄は、OpenCode のとき「ターミナルで `opencode auth login` を実行してから restart」と案内する

## セッション

```
starting ──▶ thinking ⇄ waiting
   │            │
   ▼            ▼
signed-out    error ──(restart)──▶ starting
stopped（サーバー終了時）
```

- **1 ターン = 1 つの `opencode run` 子プロセス**。Claude のストリーミング入力モードに相当する常駐セッションは持たない
  1. ターンのたびに一時ディレクトリへ `opencode.json` を書く（後述）
  2. `opencode run --standalone --format json --agent duo --auto [-m <model>] [--session <id>] <prompt>` を起動する
  3. stdout の JSON イベントを 1 行ずつ読み、チャット行・使用量に反映する
  4. 子プロセスが `close` したらターン終了。`status = 'waiting'`
  5. 子プロセスが 0 以外で終わった（API のエラーなど）ときも失敗はそのターンだけ。`⚠️ Turn ended with an error: …` を出して
     `status = 'waiting'` にし、次のメッセージで新しい `opencode run` を起動する（`❌ Agent stopped` にはしない。#51）
- 人間のメッセージはキューに積み、前のターンが終わってから順に流す（`POST /api/chat`）
- **セッション ID** はイベントの `sessionID`（`ses_…`）。ターンが正常終了したときだけ保存する
  （途中で落ちたターンを次回 resume しないため）。次回のターンは `--session` で続きを開く
  - 保存先は state ファイルの `agentSessionId` + `agentSessionBackend`。バックエンドが違う ID は使わない
    （Claude の UUID と OpenCode の `ses_…` は互換でない）。`ReviewStore.resumeIdFor(backend)` で取り出す
  - resume したときは準備フェーズのキックオフを送らない（`🏀 Resumed the previous OpenCode conversation.`）
  - 会話が見つからない等で OpenCode 側が失敗したら、エラーをチャットに出して次のメッセージから新しい会話を始める
- `POST /api/agent/interrupt` は子プロセスに `SIGTERM` を送り、`⏹ Stopped the current OpenCode turn.` を出す。すでにキューにある次のメッセージは続けて処理する
- `POST /api/agent/restart` は子プロセスを止めて config を書き直し、認証・モデル一覧を解決し直す
- サーバー終了時（`stop`）は子プロセスを止め、一時 config ディレクトリを削除する

### モデルの切り替え

- `agent.models` は `opencode models --standalone` の結果（`value`、`displayName`、`description`）
- `PUT /api/agent/model` は `agent.model` を更新してチャットにシステムメッセージを出す。次のターンから `-m` で渡す。
  設定ファイルの `agent.model` にも保存する（`--model` / 環境変数が優先）
- モデル未指定なら OpenCode の既定モデル。UI のセレクトはモデル一覧があれば出す

### 使用量

- `step_finish` イベントの `part.tokens` から `context`（`input + cache.read + cache.write`）を更新する
- `part.cost` をターンごとに足し、`agent.usage.costUSD` に入れる。`limits` は出さない
- コンテキストのリセット（下記）では `context` を消し、`costUSD` は足し続ける

## コンテキストのリセット

Claude と同じ規則・同じ `BACKCOURT_DUO_CONTEXT_RESET` のスイッチを使う（specs/sessions/agent-session.md#コンテキストのリセット）。

- ターン終了時に、phase の変化・既読ファイルの増加・プロンプト 60k トークン以上を判定する
- 当てはまったら保存中のセッション ID を捨て（`--session` を付けない）、次の人間メッセージの先頭に
  `handoffMessage` を付ける。チャットに `🧹 Agent context reset (<理由>); it continues from the shared review state.` を出す
- 会話履歴は OpenCode 側に残るが、こちらからは参照しない。store（phase、プラン、既読、pending、変更案、論点メモ、直近の会話）が記憶

## OpenCode の設定

ターンごとに `mkdtemp` したディレクトリへ `opencode.json`（mode 0600）を書き、
`OPENCODE_CONFIG=<dir>/opencode.json` と `OPENCODE_CONFIG_PROJECT_DISABLE=1` を渡して起動する。
リポジトリやユーザーの OpenCode 設定（エージェント・権限・MCP）に左右されないようにするため。

```jsonc
{
  "default_agent": "duo",
  "agents": {
    "duo": {
      "mode": "primary",
      "system": "<reviewSystemPrompt(language, 'opencode')>",
      "permissions": [
        { "action": "edit", "resource": "*", "effect": "deny" },
        { "action": "shell", "resource": "*", "effect": "deny" },
        { "action": "webfetch", "resource": "*", "effect": "deny" },
        { "action": "websearch", "resource": "*", "effect": "deny" },
        { "action": "subagent", "resource": "*", "effect": "deny" },
        { "action": "skill", "resource": "*", "effect": "deny" },
        { "action": "external_directory", "resource": "*", "effect": "deny" }
      ]
    }
  },
  "mcp": {
    "servers": {
      "duo": {
        "type": "remote",
        "url": "http://127.0.0.1:<port>/mcp",
        "oauth": false,
        "codemode": false,
        "headers": { "Authorization": "Bearer <session token>" }
      }
    }
  }
}
```

- `--standalone` は OpenCode の共有サービスを使わず、そのプロセス専用のサーバーで動かす（別 HOME でも衝突しない）
- 読み取り専用の方針（AGENTS.md 原則 4）は、組み込みツールを拒否し、`Read` / `Grep` / `Glob` 相当と duo の MCP ツールだけを使わせる。
  ファイルの書き換え・シェル・Web・サブエージェント・スキルは禁止
- GitHub への投稿は従来どおり人間の Submit からだけ（エージェントは pending まで）

## MCP エンドポイント（`/mcp`）

- `POST /mcp` の Streamable HTTP。**バックエンドが OpenCode のときだけ**有効（それ以外は 404）
- 認証は `Authorization: Bearer <session token>` のみ（MCP クライアントは Origin を送らない）。
  不一致は 401、`POST` 以外は 405
- リクエストごとに `McpServer` を作り、`duoToolDefinitions()` を登録する。ステートレス
  （`sessionIdGenerator: undefined`）かつ JSON レスポンスで、ツールの実体は Claude と共通
- ツール一覧・入出力は specs/sessions/agent-session.md#mcp-ツールサーバー名は-duo と同じ。サーバー名は `duo`

## イベントの写像

`--format json` の 1 行 1 イベントを読む。知らない `type` は無視する。

| event | 使い方 |
|---|---|
| `sessionID`（全イベント） | そのターンのセッション ID。正常終了時に保存 |
| `text`（`part.id` / `part.text`） | エージェントの発話。同じ `part.id` の再送は行を更新する |
| `tool_use`（`part.partID` / `part.tool` / `part.state`） | `state.status` が `completed` / `error` のときだけ 1 行追加。表示は `describeTool`（Claude と共通）。`partID` で行を更新する |
| `step_finish`（`part.tokens` / `part.cost`） | 使用量の更新とコストの加算 |

- ツール行は `📖 Read …`、`🔎 Grep …`、`💬 staged comment on @…` のように `describeTool` が作る
- 子プロセスの stdout は `close` を待ってからターン終了にする（末尾のイベントを取りこぼさないため）
- `BACKCOURT_DUO_DEBUG` があるときは、起動したコマンド・イベント・トークン数を stderr に出す（チャット・SSE・状態ファイルには出さない）

## 制限・今後の課題

- `--effort` と `/api/agent/effort` は OpenCode では効かない（モデルのバリアントで選ぶ）
- サインインはターミナルの `opencode auth login`（UI のボタンは案内のみ）
- バックエンドの実行中切り替えは未対応（`--agent` を付けて再起動する）
- OpenCode の無料モデルはターンが長くなることがある。子プロセスの出力が止まったように見えても、
  イベントが来るまで待つ（タイムアウトは設けていない）
