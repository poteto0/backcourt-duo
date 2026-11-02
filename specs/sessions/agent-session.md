# エージェントの会話セッション

## ライフサイクル

```
starting ──▶ thinking ⇄ waiting
   │            │
   ▼            ▼
signed-out    error ──(restart)──▶ starting
stopped（サーバー終了時）
```

- サーバーごとに `AgentSession` は 1 つだけ作る。`query({ prompt: AsyncIterable<SDKUserMessage>, options })` を
  **ストリーミング入力モード**で 1 本張り続け、人間のメッセージはキューに push する
- `includePartialMessages: true` を指定して `stream_event` のテキスト差分をチャットにリアルタイムで流す
- `result` メッセージを受け取ったら 1 ターンの終わりとみなし、`status = 'waiting'` にする
- `POST /api/agent/interrupt` で `query.interrupt()` を呼ぶ
- `POST /api/agent/restart` で close して作り直す（`resume` で同じ会話を続ける）

## モデルの切り替え

- セッションを開始したら `query.supportedModels()` の結果を `agent.models`（`value` / `resolvedModel` / `displayName` / `description`）に入れる。
  UI はこれがあればチャットのヘッダーにモデルのセレクトを出す
- `PUT /api/agent/model { model }` で `query.setModel(model)` を呼び、`agent.model` を更新してチャットにシステムメッセージを出す。
  会話はそのまま続き、次のターンから新しいモデルが使われる。エージェントが動いていなければ 409
- 切り替えたモデルは restart や再サインインのあとも使う（サーバーを再起動すると `--model` / 環境変数 / 設定ファイルの値に戻る）
- init が報告するのは解決済みの ID（例: `claude-sonnet-…`）、切り替えで渡すのはエイリアスなので、サーバーは `agent.model` を
  `value` か `resolvedModel` が一致する選択肢の `value` にそろえてから store に入れる（一致しなければそのまま）。UI は `agent.model` をそのまま選択値に使う

## SDK オプション

| option | 値 | 理由 |
|---|---|---|
| `cwd` | リポジトリのルート | Read / Grep の基準にする |
| `tools` | `['Read', 'Grep', 'Glob']` | 組み込みツールは読み取り系だけにする |
| `allowedTools` | 上記に加えて `mcp__duo__*` | 許可を確認せずに実行させる |
| `disallowedTools` | `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent` | 念のため明示的にも拒否する |
| `permissionMode` | `'dontAsk'` | 許可リストにないツールは確認せずに拒否する（人間に許可を求めるダイアログは出さない） |
| `mcpServers` | `{ duo: createSdkMcpServer(...) }` | レビュー操作のツール |
| `systemPrompt` | `{ type: 'preset', preset: 'claude_code', append: REVIEW_PROMPT }` | Claude Code の基本プロンプトにレビュー役の指示を足す |
| `settingSources` | `[]` | ユーザーやプロジェクトの hooks・権限設定に振る舞いを左右されないようにする（認証には影響しない） |
| `includePartialMessages` | `true` | |
| `resume` | 保存してあるセッション ID | 再起動しても会話を続けられるようにする |
| `model` | `--model` > `BACKCOURT_DUO_MODEL` > 設定ファイルの `agent.model`（UI で切り替えた後はその値） | 指定がなければ Claude Code の既定モデル |
| `env` | agent-claude-code.md / agent-api-key.md の規則で作った値 | |
| `pathToClaudeCodeExecutable` | agent-claude-code.md の規則で選んだ値 | |

## MCP ツール（サーバー名は `duo`）

| tool | 入力 | 効果 |
|---|---|---|
| `get_review_context` | — | target、PR（タイトルと本文）、ファイル一覧（統計、reviewState、プランのメモ）、pending、変更案、presence、phase |
| `get_file_diff` | `{ path }` | そのファイルの diff を、各行に `L<old> R<new>` を付けたテキストで返す。コメントできる行かどうかもこれで判断できる |
| `set_review_plan` | `{ summary, files: [{ path, priority: 'high'\|'medium'\|'low', note }] }` | プランを登録し、phase を `walkthrough` にする |
| `focus` | `{ path, startLine?, endLine?, side?, note? }` | エージェントのカーソルを動かし、そのファイルを `in-progress` にする |
| `get_human_focus` | — | 人間のカーソル |
| `add_pending_comment` | `{ path, line, startLine?, side?, body }` | pending に追加する（author は agent）。ハンク外の行ならエラーを返す |
| `update_pending_comment` / `delete_pending_comment` | `{ id, body? }` | 人間が書いたコメントも変更できるが、その操作はチャットに通知する |
| `propose_change` | `{ path, startLine, endLine?, replacement, note }` | 変更案を diff 上にインライン表示する（RIGHT の行番号、1 ハンク内）。ファイルは変更しない。人間が suggestion として pending に積むか却下する |
| `withdraw_proposal` | `{ id }` | 自分の変更案を取り下げる |
| `mark_file_reviewed` | `{ path }` | `reviewed` にする |
| `recommend_review` | `{ event: 'COMMENT'\|'APPROVE'\|'REQUEST_CHANGES', body }` | wrapup で推奨 verdict と総評を store の `recommendation` に登録する（再度呼ぶと上書き）。Submit ダイアログの初期値になる。投稿はしない |
| `set_phase` | `{ phase: 'walkthrough'\|'wrapup' }` | |

すべてのツールの結果は JSON テキストで返す。失敗した場合は `isError: true` にして理由を返す。

## 人間メッセージの包み方

```
<human_context>
viewing: @src/foo.ts#L10-L24 (RIGHT)
follow_agent: on
</human_context>
<activity_since_last_turn>
- opened @src/bar.ts
- added pending comment c_12 on @src/bar.ts#L8
- marked @src/baz.ts reviewed
</activity_since_last_turn>

（人間の本文）
```

チャット UI には本文だけを表示し、包んだ部分は表示しない。

## キックオフ（preparing）

起動直後（resume ではないとき）に、サーバーが次のメッセージを合成メッセージとして送る（UI には「🏀 Agent is preparing the review…」と表示する）。

> レビューの準備を始めてください。get_review_context で全体を把握し、必要なファイルの diff と周辺コードを確認したうえで、
> set_review_plan に読む順番を登録してください。終わったら変更の全体像（3〜6 行）と、最初に読むファイルとその理由を提示し、
> 進めてよいか確認してください。
