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
  --model <id>          エージェントのモデル（省略すると設定ファイルの agent.model、それもなければ Claude Code の既定モデル）
  --lang <tag>          会話とレビューの両方の言語（BCP 47。下記「言語」参照）
  --chat-lang <tag>     エージェントと話す言語
  --review-lang <tag>   GitHub に投稿されるコメント・総評の言語
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
  },
  "agent": {
    "model": "sonnet"
  },
  "language": {
    "conversation": "ja",
    "review": "en"
  }
}
```

リポジトリ設定として `<repo>/.backcourt-duo.json` も読む。書けるのは `language.review` だけ
（「この OSS には英語で書く」のようにリポジトリごとに固定するため。会話の言語は個人の好みなのでユーザー設定だけで決める）。
`language` に `review` 以外のキー（`language.conversation` など）があれば、ファイル全体を無視して warning を出す。

- 読み込みは `src/server/config.ts`。zod でスキーマを検証し、壊れた JSON や不正な値のときはファイル全体を無視する。その旨は `AgentAuthSummary.warnings` に入り、`auth status`・`doctor`・チャットに表示される（環境変数の不正な値も同じ）
- 知らないキーは無視する（ほかの機能の設定を足してもエラーにしない）
- 認証情報は入れない（AGENTS.md の原則 6）

| キー | 値 | 環境変数 | 説明 |
|---|---|---|---|
| `agent.model` | モデル ID またはエイリアス（例: `sonnet`）。省略時は Claude Code の既定モデル | `BACKCOURT_DUO_MODEL` | エージェントの既定モデル。`--model` がさらに優先する。起動後は UI で切り替えられる（specs/sessions/agent-session.md#モデルの切り替え） |
| `privacy.account` | `hide`（デフォルト） / `mask` / `show` | `BACKCOURT_DUO_ACCOUNT` | Claude アカウントのメールアドレスの表示方法（specs/sessions/agent-claude-code.md#アカウントの表示） |
| `language` | `"ja"`（両方）または `{ "conversation": "ja", "review": "en" }` | `BACKCOURT_DUO_LANG` ほか | 下記「言語」 |

優先順位は 環境変数 > 設定ファイル > デフォルト。

## 言語

言語は 2 つに分けて指定できる。値は BCP 47 の言語タグ（`ja`、`en`、`zh-Hans` など。`Intl.getCanonicalLocales` で正規化する）。

| 設定 | 対象 |
|---|---|
| `language.conversation` | エージェントとのチャット全般: 準備フェーズの概要、レビュープラン、ウォークスルーの説明、質問 |
| `language.review` | **GitHub に投稿されるもの**: エージェントが作る pending コメントの本文、`propose_change` の説明（suggestion コメントの本文になる）、`recommend_review` の総評 |

- `"language": "ja"` のように文字列で書いたときは両方に同じ言語を指定したものとして扱う
- 未指定のとき
  - `conversation` → 人間が書いた言語に合わせる（人間がまだ何も書いていない最初の発話は英語）
  - `review` → `conversation` と同じ言語。`conversation` も未指定なら PR のタイトルと本文の言語に合わせる
- 優先順位: CLI オプション > 環境変数 > リポジトリ設定（`review` のみ） > ユーザー設定 > 未指定。
  同じ段では個別の指定（`--chat-lang` / `--review-lang`、`BACKCOURT_DUO_CHAT_LANG` / `BACKCOURT_DUO_REVIEW_LANG`）が
  両方向けの指定（`--lang`、`BACKCOURT_DUO_LANG`）より優先する
- CLI に不正なタグを渡すと exit 64。環境変数の不正な値は warning を出して無視する。設定ファイルの不正な値はファイル全体を無視する（上記）
- 解決した言語は store の `language`（`{ tag, name, source }` または `null`）に入り、UI（チャットヘッダーの `💬 ja · 📝 en`）と
  エージェント（システムプロンプトと `get_review_context`）の両方に同じ値を見せる。起動時のターミナル出力と `doctor` には
  `chat ja (config) · review en (--review-lang)` のように、どこで決まったかも表示する
- 実行中には切り替えない（再起動で反映）。プロンプトへの反映は specs/sessions/agent-session.md#言語
- 人間が書いた pending コメントは翻訳しない。review の言語と違う文字体系で書かれているように見えるもの（文字種による推定。
  コードブロック・インラインコード・`@path` 参照は除く）には、UI が「Translate to English」ボタンを出す。押すとエージェントに
  翻訳を依頼し、エージェントは訳文をチャットに示して、人間が確認してから `update_pending_comment` で書き換える。
  あわせて store の `warnings` に `review-language`（「review の言語と違うように見えるコメントが N 件ある」と該当 ID）を入れる。
  チャットの警告欄・Submit ダイアログ・エージェント（`get_review_context`）に同じものが見える（投稿は止めない）
- UI の文言そのものの切り替え（i18n）は対象外

## 起動シーケンス

1. git リポジトリかどうかを確認する。違えばエラー終了（exit 2）
2. 比較対象を解決して diff を取得する。diff が空なら「差分がない」と表示して終了（exit 0）
3. セッショントークンを生成し、`127.0.0.1:<port>` で listen する。ポートが使用中なら exit 3
4. GitHub 認証を解決し、PR を検出する（失敗しても続行する）。`--pr` の場合は手順 2 より前に PR の取得と fetch を行う
5. 言語を解決し（上記「言語」）、保存されている状態があれば読み込む（`--fresh` のときは読まない）
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
