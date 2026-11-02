# GitHub 認証とレビュー投稿

## トークンの探し方

優先順位は次のとおり。

1. `GH_TOKEN`
2. `GITHUB_TOKEN`
3. `gh auth token --hostname <host>`（gh CLI のログインを引き継ぐ）

```ts
interface GitHubAuthSummary {
  ready: boolean;
  source?: 'GH_TOKEN' | 'GITHUB_TOKEN' | 'gh';
  host: string;          // github.com または GHE のホスト
  login?: string;        // GET /user で取得する（表示用）
  hint?: string;
}
```

- host は `git remote get-url origin` から求める（`git@host:o/r.git` と `https://host/o/r(.git)` の両方に対応する）
- API のベース URL は、github.com なら `https://api.github.com`、それ以外は `https://<host>/api/v3`。テストやプロキシ用に `BACKCOURT_DUO_GITHUB_API_URL` で上書きできる
- トークンはメモリに置くだけで、永続化しないし UI にも送らない

## PR の検出

`GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open&per_page=5` で検索する。
fork から出した PR を考慮して、見つからない場合は `gh pr view --json number`（gh が使える場合）でも探す。

```ts
interface PullRequestInfo { number: number; url: string; title: string; body: string; baseRef: string; headRef: string; headSha: string; author: string; draft: boolean }
```

## Submit

`POST /repos/{owner}/{repo}/pulls/{number}/reviews`

```json
{
  "commit_id": "<pr.headSha>",
  "event": "COMMENT | APPROVE | REQUEST_CHANGES",
  "body": "<総評>",
  "comments": [
    { "path": "src/a.ts", "line": 42, "side": "RIGHT", "body": "…" },
    { "path": "src/a.ts", "start_line": 10, "start_side": "RIGHT", "line": 14, "side": "RIGHT", "body": "…" }
  ]
}
```

- Submit ダイアログは、store に `recommendation`（エージェントが `recommend_review` で登録した推奨案）があれば、
  その `event` と `body` を初期値として開く。人間はそのまま投稿しても、編集してもよい。編集した場合は「推奨案に戻す」ボタンを出す。
  推奨案がなければ `COMMENT` と空の本文で開く
- `REQUEST_CHANGES` と `COMMENT` で pending が 0 件のときは、`body` が空でないことを必須にする（GitHub と同じ制約）
- 自分の PR に対する `APPROVE` / `REQUEST_CHANGES` は GitHub 側で 422 になる。そのエラーはそのまま UI に表示する
- エージェントが書いたコメントには、本文の末尾に `\n\n<sub>🤖 drafted with backcourt-duo</sub>` を付ける（人間が編集していても付ける）
- 成功したら `lastSubmission` を設定し、pending と `recommendation` を空にして、チャットに「レビューを投稿しました（リンク）」と表示する。phase は `idle` にする
- 失敗したら pending は残し、GitHub のエラーメッセージ（`errors[]` を含む）をダイアログに表示する
- ローカルの head SHA と PR の head SHA が異なる場合は、ダイアログに警告を出したうえで投稿できるようにする（行がずれたコメントは GitHub が拒否しうる）
