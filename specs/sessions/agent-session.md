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
  **ストリーミング入力モード**で 1 本張り、人間のメッセージはキューに push する。ファイルやフェーズの区切りでは張り直す（#コンテキストのリセット）
- `includePartialMessages: true` を指定して `stream_event` のテキスト差分をチャットにリアルタイムで流す
- `result` メッセージを受け取ったら 1 ターンの終わりとみなし、`status = 'waiting'` にする
- `POST /api/agent/interrupt` で `query.interrupt()` を呼ぶ
- `POST /api/agent/restart` で close して作り直す（`resume` で同じ会話を続ける）
- 保存するセッション ID（`agentSessionId`）は `result` を受け取ったときの `session_id`。init では保存しない（リセット直後の、
  引き継ぎメッセージをまだ送っていない会話を再起動時に resume しないため）

## コンテキストのリセット

1 本の `query()` を張り続けると会話履歴が線形に伸び、ファイル数の多いレビューでは終盤に毎ターン大量のトークンを再送することになる。
状態の正は `ReviewStore` なので、会話履歴は区切りごとに捨て、store を記憶として引き継ぐ。

- **捨てるもの**: `query()` の会話履歴
- **残すもの**: `ReviewStore`（phase、プラン、既読、pending、変更案、presence、チャットログ）。新しい状態は作らない

### トリガ

ターンの終わり（`result`）に、前のターンの終わりと比べて次のどれかに当たればリセットする。

| 理由 | 条件 |
|---|---|
| `phase → <phase>` | phase が変わった（preparing → walkthrough → wrapup など） |
| `file reviewed` | `reviewed` のファイル数が増えた（`mark_file_reviewed` など） |
| `context reached <n> tokens` | このターン最後のリクエストのプロンプト（`input + cache_read + cache_write`）が 60k トークン以上 |

- エージェントのターン中に人間が次のメッセージを送っていたら、そのターンではリセットしない（その返事はまだ古い会話に残っているため）。
  比較の基準は前のターンのまま残すので、次のターンの終わりで改めて判定する
- `BACKCOURT_DUO_CONTEXT_RESET=off`（`0` / `false` も可）でリセットを無効にし、従来どおり 1 本の会話を続ける

### 手順

1. 古い `query()` を close し、`resume` を付けずに新しい `query()` を張る（`resume` すると履歴が戻ってしまう）。モデルと effort はそのまま引き継ぐ
2. チャットに `🧹 Agent context reset (<理由>); it continues from the shared review state.` のシステムメッセージを出す
3. 新しい `query()` には何も送らずに待つ。次の人間メッセージの先頭に、store から作った引き継ぎメッセージを付ける

```
<handoff>
Your earlier conversation was cleared to save context (file reviewed). The shared review state is intact and is the source of truth: …
your focus: @src/b.ts#L10-L24
next in plan: @src/c.ts (high: …), @src/d.ts (medium: …), @src/e.ts (low: …) (+4 more)
pending comments: c_3 @src/a.ts#L8, c_5 @src/b.ts#L12-L14
change proposals: p_4 @src/b.ts#L20
your last message: "…（直前のエージェントの発言。300 文字まで）"
</handoff>

<human_context>…（通常どおり）
```

- 空の行（プランが無い、pending が無い など）は省く。phase と既読数は続く `<human_context>` に任せる
- 使用量の表示は、`context` を消し（古い `query()` の値なので）、`costUSD` はリセット前の分を足し続ける。`limits` はそのまま
- サーバーの再起動による resume とは別物。resume は保存したセッション ID の会話（リセット後なら、引き継ぎ以降の短い会話）を続ける。
  リセット後に 1 ターンも終わらないうちに再起動したときは、リセット前の会話を resume する
- 会話のニュアンス（「この設計は意図的と人間が言っていた」など）は store に無いので失われる。必要ならエージェントのメモ欄を足す（#24 の第 2 段階）

## モデルの切り替え

- セッションを開始したら `query.supportedModels()` の結果を `agent.models`（`value` / `resolvedModel` / `displayName` / `description`）に入れる。
  UI はこれがあればチャットのヘッダーにモデルのセレクトを出す
- `PUT /api/agent/model { model }` で `query.setModel(model)` を呼び、`agent.model` を更新してチャットにシステムメッセージを出す。
  会話はそのまま続き、次のターンから新しいモデルが使われる。エージェントが動いていなければ 409
- 切り替えたモデルは restart や再サインインのあとも使う。設定ファイルの `agent.model` にも保存するので、サーバーを再起動しても使う（`--model` / 環境変数で指定していればそちらが優先。specs/commands/start.md#設定ファイル）
- init が報告するのは解決済みの ID（例: `claude-sonnet-…`）、切り替えで渡すのはエイリアスなので、サーバーは `agent.model` を
  `value` か `resolvedModel` が一致する選択肢の `value` にそろえてから store に入れる（一致しなければそのまま）。UI は `agent.model` をそのまま選択値に使う

## effort の切り替え

- 各モデルの選択肢には `supportedEffortLevels`（`supportsEffort` が false のモデルでは省く）を入れる。
  UI は選択中のモデルにこれがあるときだけ、モデルのセレクトの隣に effort のセレクト（「default」＋ そのモデルの段階）を出す
- `PUT /api/agent/effort { effort }` で `query.applyFlagSettings({ effortLevel: effort })` を呼び、`agent.effort` を更新してチャットにシステムメッセージを出す。
  `effort: null` はモデルの既定に戻す。会話はそのまま続き、次のターンから新しい effort が使われる。エージェントが動いていなければ 409
- 切り替えた effort はモデルと同じく restart や再サインインのあとも使い、設定ファイルの `agent.effort` にも保存する（`null` はキーを消す）
- モデルが対応しない段階（例: `max` 非対応のモデル）は SDK 側で丸められる。`agent.effort` は選んだ値のまま表示する

## 残量の表示

エージェントがあとどれくらい使えるかを、チャットペインのヘッダー直下に常に表示する（`agent.usage`、SSE で配信。状態ファイルには保存しない）。

| 項目 | 出どころ | 更新タイミング |
|---|---|---|
| `context`（`used` / `max` トークン） | `query.getContextUsage({ detail: 'summary' })` の `totalTokens` / `maxTokens` | `result` を受け取るたび |
| `limits`（プラン上限の窓ごとの `utilization`（0–1）・`resetsAt`（epoch ms）・`status`） | `rate_limit_event` の `rate_limit_info`。1 イベント 1 窓なので `rateLimitType` ごとに最新値で置き換える。`utilization` のないイベントと、値が変わらないイベントは無視する（SSE を流さない） | イベントを受け取るたび（サブスクのみ。API キーでは来ない） |
| `costUSD` | `result.total_cost_usd`（`query()` ごとの累積）。API キーのときだけ入れる（サブスクでは請求額ではないため） | `result` を受け取るたび |

- `result` のあとの `context` と `costUSD` は 1 回の store 更新にまとめる
- `context` と `costUSD` は `query()` ごとの値なので、`query()` を張り直す（restart・再サインイン）ときに消す。`limits` はアカウントの値なので残す。
  コンテキストのリセットでは `context` だけ消し、`costUSD` は足し続ける（#コンテキストのリセット）
- UI は「残り」で見せる: context は `1 - used/max`、各窓は `1 - utilization`（`status: 'rejected'` は 0%）。残りが 20% を切ると警告色にする
- 窓のリセット時刻を表示し、リセット時刻を過ぎた窓は今の値ではないので出さない
- 何もわかっていないあいだ（最初のターンが終わるまで）はメーター自体を出さない
- 実験的 API（`usage_EXPERIMENTAL_…`）は使わない

## トークン計測（デバッグ用）

`BACKCOURT_DUO_DEBUG` が設定されているとき、`result` を受け取るたびに stderr へ 1 ターン 1 行で消費量を出す（削減の優先順位づけと効果測定のため）。

```
[tokens] turn=3 in=12.4k cache_read=180k cache_write=9k out=1.2k thinking=800 cost=$0.031 tools=get_review_context×1:8.2k,get_file_diff×3:21k,Read×2:6.4k
```

- `in` / `cache_read` / `cache_write` / `out` / `thinking` / `cost` は `result.modelUsage`（全モデルの合計）の前ターンとの差。`thinking` は 0 のとき省く（`out` に含まれる）
- `modelUsage` は `query()` ごとの累積なので、`query()` を張り直す（restart・再サインイン・コンテキストのリセット）と差分の基準も作り直す。
  そのため最初のターンは SDK の報告値そのまま（resume したときは前回までの累積を含む）
- `tools` はそのターンに呼んだツールごとの「回数:結果の文字数（`tool_result` の `content`）」。MCP ツールは `mcp__duo__` を省いた名前で出す。ツールを呼ばなかったターンでは省く
- `turn` は `query()` を張ってからのターン数
- チャット・SSE・状態ファイルには出さない（デバッグ専用）。デバッグでないときは集計もしない

## SDK オプション

| option | 値 | 理由 |
|---|---|---|
| `cwd` | リポジトリのルート | Read / Grep の基準にする |
| `tools` | `['Read', 'Grep', 'Glob']` | 組み込みツールは読み取り系だけにする |
| `allowedTools` | 上記に加えて `mcp__duo__*` | 許可を確認せずに実行させる |
| `disallowedTools` | `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent` | 念のため明示的にも拒否する |
| `permissionMode` | `'dontAsk'` | 許可リストにないツールは確認せずに拒否する（人間に許可を求めるダイアログは出さない） |
| `mcpServers` | `{ duo: createSdkMcpServer(...) }` | レビュー操作のツール |
| `systemPrompt` | `{ type: 'preset', preset: 'claude_code', append: reviewSystemPrompt(language) }` | Claude Code の基本プロンプトにレビュー役の指示と言語の指示（下記）を足す |
| `settingSources` | `[]` | ユーザーやプロジェクトの hooks・権限設定に振る舞いを左右されないようにする（認証には影響しない） |
| `includePartialMessages` | `true` | |
| `resume` | 保存してあるセッション ID（コンテキストのリセットで張り直すときは付けない） | 再起動しても会話を続けられるようにする |
| `model` | `--model` > `BACKCOURT_DUO_MODEL` > 設定ファイルの `agent.model`（UI で切り替えるとここに保存される） | 指定がなければ Claude Code の既定モデル |
| `effort` | `--effort` > `BACKCOURT_DUO_EFFORT` > 設定ファイルの `agent.effort`（UI で切り替えるとここに保存される） | 指定がなければモデルの既定 |
| `env` | agent-claude-code.md / agent-api-key.md の規則で作った値 | |
| `pathToClaudeCodeExecutable` | agent-claude-code.md の規則で選んだ値 | |

## MCP ツール（サーバー名は `duo`）

| tool | 入力 | 効果 |
|---|---|---|
| `get_review_context` | `{ detail?: 'lean'\|'full', includeBodies? }` | target、PR（タイトルと本文）、プラン（`summary` と読む順番。各ファイルの `priority` / `note` はプラン側にだけ載せる）、ファイル一覧（統計、reviewState、lockfile / 生成物なら `skipped: 'lockfile'\|'generated'`）、pending、変更案、推奨 verdict、presence、phase、warnings。デフォルトの `lean` では PR 本文を 1500 文字で切り、pending は `{ id, path, side, line, startLine, author }`、推奨 verdict は `{ event }` だけ返し（本文は `includeBodies: true` のときだけ）、`language` は省く（システムプロンプトにあるため）。`full` では PR 本文を 6000 文字まで、本文と `language` も返す。どちらでも入れ子も含めて空配列・空オブジェクト・空文字列・`false`・`null`・未設定のフィールドは省く（warnings が無ければ `warnings` ごと省く） |
| `get_file_diff` | `{ path, offset?, force? }` | そのファイルの diff をテキストで返す。追加行と文脈行には新しい行番号 `R<new>`、削除行には古い行番号 `L<old>` を付ける。コメントできる行かどうかもこれで判断できる。1 回で返すのは diff 600 行までで、切り詰めたときは末尾に続きの `offset`（読み飛ばす diff 行数）を示す。1 行は 300 文字で切る。lockfile（`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `Gemfile.lock`）と生成物（`dist/` `build/` `vendor/` 配下、`*.min.js`, `*.min.css`, `*.map`, `*.snap`。ディレクトリはどの階層でもよい）は本文を返さず、`(skipped: lockfile — 1,234 changed lines. Pass force: true to read it.)` の 1 行だけを返す。`force: true` なら通常どおり返す |
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

すべてのツールの結果は JSON テキストで返す（トークン節約のためインデントなしの compact JSON。文字列はそのまま返す）。`propose_change` は `{ ok, id }` だけを返す（置き換え前の行は直前の `get_file_diff` で見ているので返さない）。失敗した場合は `isError: true` にして理由を返す。

本文の二重生成を避けるため、システムプロンプトでは `add_pending_comment` / `propose_change` を直接呼ばせ、その本文や置き換え後のコードを
チャットに書かせない。本文は UI の diff にインラインで出るし、ツール呼び出しはチャットに `💬 staged comment on @path#L…` のような
クリックできる 1 行として自動で出る。エージェントが添えるのは短い理由だけにする。本文をチャットに書くのは、人間が見せてと頼んだときと、
会話と review の言語が違うとき（#言語）だけ。

## 言語

store の `language`（specs/commands/start.md#言語）から、システムプロンプトの `## Language` 節を組み立てる。

- 会話: 指定があれば「人間とは Japanese (ja) で話す（概要、プラン、説明、質問）」。なければ「人間が書いた言語で話す。まだ何も書いていなければ英語」
- review: 「GitHub に投稿されるもの（`add_pending_comment` / `update_pending_comment` の本文、`propose_change` の説明、`recommend_review` の総評）は English (en) で書く」。
  未指定なら「PR のタイトルと本文の言語で書く（PR がない・判断できなければ英語）」
- 2 つが違うときは、積むときに投稿される本文そのものをチャットにも見せ（翻訳を確認できるように。#MCP ツールの本文を書かない規則の例外。
  必要なら会話の言語で 1 行の要約を添える）、会話の言語で「積んでおいて」と頼まれたら review の言語に翻訳してから積むよう指示する
- コードの識別子、`@path#L` 参照、コードブロック、suggestion ブロックは翻訳しない
- 人間が書いたコメントは頼まれない限り翻訳・書き換えをしない。頼まれたら訳文を先に見せ、確認を得てから更新する
- 会話の言語が指定されていれば、キックオフの末尾に「Reply in Japanese.」を足す

resume したときもシステムプロンプトは現在の設定で組み立て直す。さらに、前回の会話を始めたときの言語（状態ファイルに保存しておく）と
今の設定が違えば、store の操作ログに「言語設定が変わった（`chat ja (config) · review en (--review-lang)`）。以降は Language 節に従う」を 1 行積む。
次の人間メッセージの `<activity_since_last_turn>` で 1 度だけエージェントに届く（それまでの会話が別の言語で進んでいても、以降は新しい設定に従わせるため）。

実行中に UI で言語を切り替えたとき（specs/commands/start.md#言語）は、走っているセッションのシステムプロンプトは変えられないので、
store（`ReviewStore.setLanguage`）が操作ログに「言語設定が変わった（…）。システムプロンプトの Language 節の代わりにこれに従う」と新しい `## Language` 節の本文を積む。
まだ届いていない以前の言語の通知は置き換えるので、次の人間メッセージで最新の設定が 1 度だけ届く。チャットにも `🌐 Language switched: …` のシステムメッセージを出す。restart / resume のときは現在の設定でシステムプロンプトを組み立て直す。

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
