# `backcourt-duo doctor`

起動前のチェックを一通り実行し、問題を指摘する。サーバーもエージェントも起動しない（ネットワークへのアクセスは GitHub API の PR 検索だけ）。

## チェック項目

| # | 項目 | OK の条件 | NG のときの案内 |
|---|---|---|---|
| 1 | Node.js | >= 24（開発は 26） | アップグレードを促す |
| 2 | git リポジトリ | `git rev-parse --show-toplevel` が成功する | `-C <dir>` を指定する |
| 3 | default ブランチ | specs/commands/start.md の手順で解決できる | `git remote set-head origin -a` か `--base` を使う |
| 4 | 差分 | merge-base..HEAD に 1 ファイル以上ある | — |
| 5 | remote | `origin` が GitHub（github.com または GHE）を指している | Submit は使えないと警告する |
| 6 | GitHub 認証 | トークンが得られる | `backcourt-duo auth login --github` |
| 7 | PR | 現在のブランチに open な PR がある | `gh pr create` か `--pr` を使う |
| 8 | push 状態 | PR の head SHA がローカルの HEAD と一致する | `git push` を促す |
| 9 | 言語 | 常に OK。`chat ja (config) · review en (--review-lang)` のように、解決した言語とどこで決まったかを表示する | 環境変数・リポジトリ設定の不正な値は ⚠ |
| 10 | エージェント認証 | 選択中のモードで使える | specs/sessions/agent-*.md の案内 |
| 11 | ポート | 1200（または `--port`）が空いている | `--port` |

出力は `✔` / `⚠` / `✖` と 1 行の説明。`--json` を付けると機械可読な形で出力する。
✖ が 1 つでもあれば exit 1、⚠ だけなら exit 0。

オプションは `-C, --cwd`、`--base`、`--pr`、`--port`、`--auth`、`--lang`、`--chat-lang`、`--review-lang`、`--json`（意味は start と同じ）。
