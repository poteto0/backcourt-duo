# `backcourt-duo [start]`

レビューサーバーを起動し、ブラウザを開き、エージェントにレビューの準備を始めさせる。
サブコマンドを省略したときはこのコマンドが実行される。

## 使い方

```
backcourt-duo [start] [options]

  --base <ref>          比較元。デフォルトは default ブランチ（下記参照）
  --head <ref>          比較先。デフォルトは HEAD
  --pr <number>         投稿先の PR 番号を指定する（省略するとブランチから自動で検出する）
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

## PR の検出

- `--pr` を指定した場合はその PR を使う
- 指定がなければ、remote `origin` の owner/repo と現在のブランチ名から `GET /repos/{o}/{r}/pulls?head={o}:{branch}&state=open` で検索する
- PR が見つからなくてもサーバーは起動する。ただし Submit は無効になり、UI に「PR が見つからない」と表示される
- PR の base ブランチが比較元と異なる場合、および PR の head SHA がローカルの head と異なる場合（未 push のコミットがある場合など）は UI に警告を出す

## 起動シーケンス

1. git リポジトリかどうかを確認する。違えばエラー終了（exit 2）
2. 比較対象を解決して diff を取得する。diff が空なら「差分がない」と表示して終了（exit 0）
3. セッショントークンを生成し、`127.0.0.1:<port>` で listen する。ポートが使用中なら exit 3
4. GitHub 認証を解決し、PR を検出する（失敗しても続行する）
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
