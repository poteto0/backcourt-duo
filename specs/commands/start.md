# `backcourt-duo [start]`

レビューサーバーを起動し、ブラウザを開き、エージェントにレビューの準備を始めさせる。
サブコマンドを省略したときはこのコマンドが実行される。

## 使い方

```
backcourt-duo [start] [options]

  --base <ref>          比較元。デフォルトは default ブランチ（下記参照）
  --head <ref>          比較先。デフォルトは HEAD
  --pr <number>         その PR をレビューする。PR の head を origin から fetch し、PR の base と比較する（下記参照）。
                        省略すると現在のブランチから PR を自動で検出する
  --uncommitted         working tree の未コミット変更も diff に含める（その行へのコメントは投稿時に失敗しうる）
  --port <n>            デフォルトは 1200（環境変数 BACKCOURT_DUO_PORT でも指定可）
  --host <addr>         デフォルトは 127.0.0.1。ループバック以外のアドレスは拒否する
  --auth <mode>         エージェントの認証。claude-code（デフォルト）または api-key
  --model <id>          エージェントのモデル（省略すると Claude Code の既定モデル）
  --no-open             ブラウザを開かない
  --no-agent            エージェントを起動しない（diff と pending と Submit だけを使う）
  --fresh               保存されている状態（pending、チャット、セッション）を破棄して始める
  -C, --cwd <dir>       対象リポジトリ（デフォルトはカレントディレクトリ）
```

## 比較対象の決め方

1. `--base` があればそれを使う
2. なければ default ブランチを使う。次の順に探し、最初に見つかったものを採用する
   1. `git symbolic-ref --short refs/remotes/origin/HEAD`（例: `origin/main`）
   2. `gh repo view --json defaultBranchRef`（gh が使える場合）→ `origin/<name>`
   3. `origin/main`、`origin/master`、`main`、`master` のうち存在するもの
3. diff は **GitHub の Files changed と同じ three-dot 方式**で取る: `git diff --merge-base <base> <head>`
   （`--uncommitted` のときは `git diff --merge-base <base>` で working tree と比較する）
4. オプションは `-M`（rename 検出）と `--no-color --no-ext-diff` を付ける。バイナリは `binary: true` として本文を省く

## `--pr` を指定したとき

チェックアウトや worktree なしで、任意の PR をレビューできる。

1. `GET /repos/{o}/{r}/pulls/{n}` で PR を取得する（GitHub 認証がない、または失敗した場合は base 不明のまま続ける）
2. `git fetch --no-tags origin +refs/pull/{n}/head:refs/backcourt-duo/pr/{n} +refs/heads/{baseRef}:refs/remotes/origin/{baseRef}` を実行する
   - `refs/pull/{n}/head` を使うので fork からの PR も取れる
   - 取得した head は `refs/backcourt-duo/pr/{n}` に置く。`refs/heads` には書かないので、ユーザーのブランチや working tree は変わらない
   - fetch に失敗したらエラー終了（exit 2）
3. 比較対象は head = `refs/backcourt-duo/pr/{n}`、base = `--base` があればそれ、なければ `origin/{baseRef}`（PR を取得できなかった場合は default ブランチ）
4. `target.branch` には PR の head ブランチ名（取得できなければ `pr-{n}`）を入れる。保存状態のキーにもこれを使う

例外として、`--head` または `--uncommitted` を一緒に指定した場合は fetch せず、ローカルの比較対象をそのまま使う。このとき `--pr` は投稿先の PR を決めるだけになる。

## PR の検出

- `--pr` を指定した場合はその PR を使う（上記）
- 指定がなければ、remote `origin` の owner/repo と現在のブランチ名から `GET /repos/{o}/{r}/pulls?head={o}:{branch}&state=open` で検索する
- PR が見つからなくてもサーバーは起動する。ただし Submit は無効になり、UI に「PR が見つからない」と表示される
- PR の base ブランチが比較元と異なる場合、および PR の head SHA がローカルの head と異なる場合（未 push のコミットがある場合など）は UI に警告を出す

## 設定ファイル

ユーザー設定は `~/.backcourt-duo/config.json` に置く（なければ全項目が未指定として扱う）。

```json
{
  "privacy": {
    "account": "hide"
  }
}
```

- 読み込みは `src/server/config.ts`。zod でスキーマを検証し、壊れた JSON や不正な値のときはファイル全体を無視する。その旨は `AgentAuthSummary.warnings` に入り、`auth status`・`doctor`・チャットに表示される（環境変数の不正な値も同じ）
- 知らないキーは無視する（ほかの機能の設定を足してもエラーにしない）
- 認証情報は入れない（AGENTS.md の原則 6）

| キー | 値 | 環境変数 | 説明 |
|---|---|---|---|
| `privacy.account` | `hide`（デフォルト） / `mask` / `show` | `BACKCOURT_DUO_ACCOUNT` | Claude アカウントのメールアドレスの表示方法（specs/sessions/agent-claude-code.md#アカウントの表示） |

優先順位は 環境変数 > 設定ファイル > デフォルト。

## 起動シーケンス

1. git リポジトリかどうかを確認する。違えばエラー終了（exit 2）
2. 比較対象を解決して diff を取得する。diff が空なら「差分がない」と表示して終了（exit 0）
3. セッショントークンを生成し、`127.0.0.1:<port>` で listen する。ポートが使用中なら exit 3
4. GitHub 認証を解決し、PR を検出する（失敗しても続行する）。`--pr` の場合は手順 2 より前に PR の取得と fetch を行う
5. 保存されている状態があれば読み込む（`--fresh` のときは読まない）
6. ブラウザで `http://localhost:<port>/?token=<token>` を開き、URL をターミナルにも表示する
7. エージェントの認証を解決する（specs/sessions/agent-*.md）
   - 使える場合はセッションを開始し、キックオフメッセージ（preparing フェーズ）を送る。復元したセッションがある場合は resume し、キックオフは送らない
   - claude-code モードでサインインしていない場合は `agent.status = 'signed-out'` にし、UI に「Sign in with Claude」ボタンを出す
8. `SIGINT` / `SIGTERM` を受けたら状態を保存し、エージェントを close して終了する

## 終了コード

| code | 意味 |
|---|---|
| 0 | 正常終了（差分なしを含む） |
| 1 | 予期しないエラー |
| 2 | git リポジトリではない、または ref を解決できない |
| 3 | ポートが使用中、または bind できない |
