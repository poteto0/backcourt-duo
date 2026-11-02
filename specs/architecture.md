# アーキテクチャ

```
┌──────────── browser (SolidJS) ────────────┐        ┌──────── backcourt-duo (Node) ────────┐
│ FileTree │ DiffView           │ ChatPanel │  SSE   │ ReviewStore ── persist → .git/backcourt-duo/
│  👤🤖     │ inline pending     │ stream    │◀──────│   ▲      ▲                                │
│          │ comments            │           │  REST │   │      │ MCP tools (in-process)        │
│          │                     │           │──────▶│ http.ts  AgentSession ── Claude Agent SDK │
└───────────────────────────────────────────┘        │            │ query(streaming input)       │
                                                      │ git.ts / diff.ts      github.ts ── PR API │
                                                      └──────────────────────────────────────────┘
```

## ReviewStore（唯一の正）

```ts
interface ReviewState {
  target: { base: string; baseSha: string; head: string; headSha: string; mergeBaseSha: string; uncommitted: boolean };
  pr: PullRequestInfo | null;          // remote の PR（見つからなければ null）
  files: FileEntry[];                  // diff 対象ファイル（path, status, additions, deletions, reviewState）
  plan: ReviewPlan | null;             // エージェントが作った読む順番と各ファイルのメモ
  phase: 'preparing' | 'walkthrough' | 'wrapup' | 'idle';
  presence: { human: Cursor | null; agent: Cursor | null };
  followAgent: boolean;                // UI がエージェントのカーソルに追従するか
  pending: PendingComment[];
  proposals: ChangeProposal[];         // エージェントの変更案（表示のみ。ファイルには適用しない）
  agent: { status: 'starting' | 'thinking' | 'waiting' | 'error' | 'stopped' | 'signed-out'; auth: AgentAuthSummary; error?: string };
  github: { auth: GitHubAuthSummary };
  lastSubmission: { url: string; at: string; count: number } | null;
  recommendation: { event: 'COMMENT'|'APPROVE'|'REQUEST_CHANGES'; body: string } | null; // エージェントの推奨案
}
```

- `Cursor = { path, startLine?, endLine?, side?, note?, at }`
- `FileEntry.reviewState = 'unvisited' | 'in-progress' | 'reviewed'` にする。GitHub の "Viewed" にあたる。
  エージェントが `focus` すると `in-progress` になり、人間かエージェントが既読にすると `reviewed` になる
- `PendingComment = { id, path, side: 'LEFT'|'RIGHT', line, startLine?, body, author: 'human'|'agent', createdAt, updatedAt }`
  - `line` / `startLine` は GitHub API と同じ意味。`RIGHT` は新しい側の行番号、`LEFT` は古い側の行番号を指す
  - 作成時に「diff のハンク内にある行か」を検証する（GitHub はハンク外の行へのコメントを拒否するため）

- `recommendation` はエージェントが `recommend_review` で登録する推奨 verdict と総評。Submit ダイアログはこれを初期値として開く
  （specs/sessions/github.md）。永続化するが、エージェントのセッションと同じく head / merge-base が変わったら捨てる。Submit に成功したら消す

- `ChangeProposal = { id, path, startLine, endLine, original: string[], replacement: string[], note, createdAt }`
  - エージェントが `propose_change` で作る「こう直すとどうなるか」の提示。**作業ツリーのファイルは一切変更しない**
  - 範囲は新しい側（RIGHT）の行番号で、両端が同じハンク内にあること（そのまま GitHub の suggestion にできるように）。
    `original` は作成時の diff から取り出した現在の行
  - UI では範囲の最終行の下に「元の行（-）→ 提案（+）」のミニ diff として表示し、ファイルツリーに 💡 件数を出す
  - 人間は **Stage as suggestion**（本文に ```` ```suggestion ```` ブロックを入れた pending コメントに変換。author は agent）か
    **Dismiss** を選ぶ。どちらの操作も人間の操作ログに入る
  - 永続化する。再起動時に `original` が現在の diff と一致しないものは捨てる

store が変更されると `state` イベント（チャットを含まないスナップショット）を全 SSE クライアントに送る。
チャットは量が多いので別系統の `chat` イベント（`append` / `delta` / `update`）として送る。

### 永続化

状態は `<git-dir>/backcourt-duo/<head-branch>.json` に保存する（pending、変更案、推奨案、reviewState、plan、チャットログ、エージェントのセッション ID）。
`.git` の中に置くので誤ってコミットされない。同じブランチで再起動すると復元され、エージェントも SDK の `resume` で会話を引き継ぐ。
`--fresh` を付けると破棄して最初から始める。Submit に成功したら pending と推奨案は空にする。

## Presence（「いまどこを読んでいるか」の共有）

人間とエージェントのどちらにも同じ形で見えることを最重要にしている。

| 情報 | 人間にはどう見えるか | エージェントにはどう見えるか |
|---|---|---|
| エージェントのカーソル | ツリーの 🤖 バッジ、diff 上で行範囲を紫でハイライト、ヘッダーの「🤖 Agent is on …」 | 自分で `focus` した結果 |
| 人間のカーソル | ツリーの 👤 バッジ、選択行のハイライト | 人間の各メッセージに付く `<human_context>`、および `get_human_focus` ツール |
| 既読状態 | ツリーのチェック、ファイルヘッダーの "Viewed" | `get_review_context` の `reviewState` |
| 人間の操作ログ | — | 次のメッセージに付く `<activity_since_last_turn>`（開いたファイル、追加・削除したコメント、既読にしたファイル） |

UI の操作:
- **Follow agent**（デフォルトはオン）: エージェントが `focus` すると中央の diff がその位置まで自動でスクロールする。人間が別のファイルをクリックすると自動でオフになる
- **Bring agent here**: 人間がいま見ている箇所（`@path#Lx-Ly`）を引用した状態でチャット入力に挿入する
- 行番号をクリックすると人間のカーソルが動く（shift+クリックで範囲選択）。カーソルの位置は URL の hash（`#path:L10-L20`）にも反映し、共有できるようにする
- チャット内の `@path#L10-L20` はクリックでジャンプできるチップとして表示する

人間のカーソル更新は `PUT /api/presence` で送る（UI 側で 250ms の debounce をかける）。

## エージェントのフェーズ

1. `preparing`: 起動直後にサーバーが自動でキックオフメッセージを送る。エージェントは `get_review_context` を呼び、
   必要に応じて `get_file_diff` / `Read` / `Grep` で調べ、`set_review_plan` で読む順番と要約を登録する。
   最後に全体像と「どこから読むか」をチャットで提示し、人間に確認を求める
2. `walkthrough`: 1 ファイルずつ `focus` → 説明 → 気になる点の提示と質問 → 人間の返答を待つ、を繰り返す。
   合意した指摘は `add_pending_comment` で pending に積む。終わったファイルには `mark_file_reviewed` を呼ぶ
3. `wrapup`: 全ファイルを見終わると `set_phase('wrapup')` に移る。pending の一覧をまとめ、`recommend_review` で推奨 verdict と総評を登録する（Submit ダイアログに初期値として入る）
4. `idle`: Submit 後。以降は質問に答えるだけになる

フェーズの遷移は MCP ツール経由でエージェントが宣言する。人間はチャットでいつでも割り込める（「先に X を見たい」など）。

## HTTP API（すべて `/api` 配下で、セッション必須）

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/state` | ReviewState |
| GET | `/api/diff` | `DiffFile[]`（ハンクと行。old/new の行番号付き） |
| GET | `/api/events` | SSE（`state`, `chat`, `hello`） |
| GET | `/api/chat` | チャット履歴 |
| POST | `/api/chat` | `{ text }` 人間のメッセージ。presence と操作ログを添えてエージェントに送る |
| POST | `/api/agent/interrupt` | 実行中のターンを中断する |
| PUT | `/api/agent/model` | エージェントのモデルを切り替える（`{ model }`。specs/sessions/agent-session.md#モデルの切り替え） |
| POST | `/api/agent/restart` | エージェントセッションを作り直す（認証を変えたあとなど） |
| PUT | `/api/presence` | 人間のカーソル |
| PUT | `/api/follow` | `{ followAgent }` |
| PUT | `/api/files/review-state` | `{ path, reviewState }` |
| POST | `/api/pending` | pending コメントの作成 |
| PATCH | `/api/pending/:id` | 本文の編集 |
| DELETE | `/api/pending/:id` | 削除 |
| POST | `/api/proposals/:id/stage` | 変更案を suggestion 付きの pending コメントに変換する |
| DELETE | `/api/proposals/:id` | 変更案を却下する |
| POST | `/api/submit` | `{ event: 'COMMENT'|'APPROVE'|'REQUEST_CHANGES', body }` PR に投稿 |
| POST | `/api/auth/claude/login` | `claude auth login --claudeai` を起動する（サブスクでのサインイン） |
