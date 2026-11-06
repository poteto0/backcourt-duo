# 🏀 backcourt-duo

PR を Claude エージェントと **ふたりでレビュー**するローカルツール。

## インストール（Nix）

```sh
cd your-repo
nix run github:poteto0/backcourt-duo             # その場で起動（今のブランチの PR）
nix run github:poteto0/backcourt-duo -- --pr 345 # PR #345 をチェックアウトせずにレビュー
nix profile install github:poteto0/backcourt-duo # backcourt-duo コマンドとして入れる
```

実行時の Node は Nix の Node 26 に固定されるので、手元の Node のバージョンには影響されない。
エージェントは手元の `claude`（Claude Code）を使うので、事前にインストールしておくこと（`--auth api-key` のときも必要）。

## 開発用セットアップ

```sh
nix develop          # Node 26 + pnpm + gh
pnpm install && pnpm build
alias backcourt-duo="node $PWD/bin/backcourt-duo.js"   # または pnpm link --global
```

`pnpm-lock.yaml` を変えたら、`flake.nix` の `pnpmDeps.hash` も更新すること（`nix build` が出す `got:` の値に差し替える）。

## 使い方

```sh
cd your-repo         # PR を出しているブランチで
backcourt-duo        # → http://localhost:1200 が開く
```

1. エージェントがレビューの準備をして、読む順番を提案する
2. チャットで質問しながら、1 ファイルずつ一緒に読む（🤖 = エージェントの位置、👤 = あなたの位置）
3. 行番号の `+` でコメントする。エージェントにも「積んでおいて」と頼める
4. **Submit review** を押すと、溜めたコメントが PR に投稿される

## 認証

- **Claude**: Claude Code のサインインをそのまま使う（サブスクで OK）。未ログインなら画面の「Sign in with Claude」か `backcourt-duo auth login`。API キーを使うときは `--auth api-key`（`ANTHROPIC_API_KEY`）
- **GitHub**: `gh auth login` 済みならそのまま使える（または `GH_TOKEN`）

## よく使うオプション

```sh
backcourt-duo --base origin/develop   # 比較元を変える（デフォルトは default ブランチ）
backcourt-duo --pr 123                # 投稿先の PR を指定する
backcourt-duo doctor                  # 動かないときの診断
backcourt-duo auth status             # 認証状態を確認する
```

詳しくは [AGENTS.md](AGENTS.md) と [specs/](specs/) を参照。
