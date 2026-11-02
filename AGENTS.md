# AGENTS.md — backcourt-duo

人間と AI エージェントが「ふたりで」コードレビューするためのローカルツール。
バスケのバックコート・デュオ（PG と SG）のように、片方がボールを運び（エージェントが
レビューの準備と案内をする）、もう片方が判断を下す（人間が質問し、コメントを確定させる）。

> CLI 名は `backcourt-duo`。打ち間違いを吸収するため `backcort-duo` もエイリアスとして登録している。

## 何をするツールか

1. リポジトリ内で `backcourt-duo` を実行すると `http://localhost:1200` でサーバーが起動し、ブラウザが開く。
2. 画面は GitHub の "Files changed" に近い 3 ペイン構成になっている。
   - 左: ファイルツリー。人間とエージェントがそれぞれ見ているファイル（presence）と、既読状態を表示する
   - 中央: diff。デフォルトは **default ブランチとの merge-base から HEAD まで**
   - 右: エージェントとのチャット
3. 起動するとすぐ、エージェントが **準備フェーズ**（PR 概要・変更ファイル・リスクを把握し、読む順番＝レビュープランを作る）を始める。
4. 次に **ウォークスルーフェーズ** に入り、エージェントはファイルを 1 つずつ開いて要点を説明し、人間に質問しながら進める。
5. 気になる点は **pending コメント** として溜めていく（人間が書いても、エージェントが提案してもよい）。
6. **Submit** を押すと、溜めた pending コメントが remote の PR に 1 つのレビューとしてまとめて投稿される。

## リポジトリ構成

```
bin/backcourt-duo.js      CLI のエントリ（dist/server/cli.js を読み込むだけ）
src/shared/               サーバーと Web が共有する型・プロトコル（ランタイム依存なし）
src/server/               Node 側（CLI、HTTP、git、GitHub、エージェント）
  cli.ts                  サブコマンドのディスパッチ
  commands/               各コマンドの実装（specs/commands/ と 1:1 対応）
  auth/                   認証（specs/sessions/ と 1:1 対応）
  git.ts / diff.ts        git の呼び出しと unified diff のパーサ
  github.ts               PR の検索とレビューの投稿
  store.ts                レビュー状態（唯一の正）とイベントバス
  agent/                  Claude Agent SDK セッション、MCP ツール、プロンプト
  http.ts                 Hono アプリ（REST + SSE + 静的配信）
src/web/                  SolidJS の UI（Vite でビルド）
specs/commands/           CLI コマンドの仕様
specs/sessions/           認証・セッションの仕様
specs/architecture.md     状態モデル、presence、プロトコル
```

## 技術スタック

- **TypeScript 7.0**（ネイティブ版 `tsc`）。`strict` に加え、`exactOptionalPropertyTypes` と `noUncheckedIndexedAccess` を有効にしている
- Node.js 26（`nix develop` か direnv の `use flake` で入る。flake.nix を参照）。ESM のみ。engines は >=24
- サーバー: Hono と `@hono/node-server`
- エージェント: `@anthropic-ai/claude-agent-sdk`
- Web: SolidJS と Vite（`vite-plugin-solid`）
- サーバーは `tsc -p tsconfig.server.json` で `dist/server` に出力し、Web は `vite build` で `dist/web` に出力する

## 開発コマンド

```sh
nix develop      # Node 26 + pnpm + gh（direnv があれば自動）
pnpm install
pnpm build          # server (tsc) + web (vite)
pnpm typecheck
pnpm test           # node --test（ビルド後の dist に対して実行）
node bin/backcourt-duo.js --help
```

UI を開発するとき: `pnpm build:web --watch` を動かしたまま `node bin/backcourt-duo.js` を起動し、ブラウザをリロードする。
（セッション Cookie と Origin チェックがあるので、Vite の dev server を経由したプロキシは使わない）

## 設計の原則（変更するときに守ること）

1. **状態の正はサーバーの `ReviewStore` だけ**。UI もエージェントも store を読み書きするクライアントにすぎない。
   UI には SSE で配信し、エージェントは MCP ツール経由で読み書きする。どちらか一方だけが知っている状態を作らないこと。
2. **Presence は第一級の概念**。人間のカーソル（見ているファイル・行範囲）とエージェントのカーソルは
   store の `presence` に入れ、両者に同じ形で見せる。エージェントへの人間メッセージには、
   送信時点の人間の presence と「前回のターンからの人間の操作ログ」を必ず添付する。
3. **ファイル参照の書式は `@path/to/file.ts#L10-L20` に統一する**。チャット中のこの書式は UI でクリック可能なチップとして表示され、
   クリックすると該当箇所へジャンプする。エージェントのシステムプロンプトにもこの書式を使うよう指示してある。
4. **エージェントは読み取り専用**。組み込みツールは `Read` / `Grep` / `Glob` だけを許可し、書き込み系と Bash は拒否する。
   GitHub への投稿は人間の Submit 操作からしか起きない（エージェントは pending を溜めるところまで）。
5. **ローカルサーバーは 127.0.0.1 にのみ bind し、セッショントークンを必須にする**（specs/sessions/local-server.md）。
6. 認証情報（API キー、OAuth トークン、GitHub トークン）は、ログ・SSE・永続化ファイル・エージェントのコンテキストのどこにも出さない。
   Claude アカウントのメールアドレスも、デフォルトでは出さない（`privacy.account`。マスクはサーバー側で行う。specs/sessions/agent-claude-code.md）。

## 仕様書

実装を変えるときは対応する仕様書も更新すること。

- コマンド: `specs/commands/start.md`, `specs/commands/auth.md`, `specs/commands/doctor.md`
- 認証・セッション: `specs/sessions/agent-claude-code.md`, `specs/sessions/agent-api-key.md`,
  `specs/sessions/github.md`, `specs/sessions/local-server.md`, `specs/sessions/agent-session.md`
- 全体: `specs/architecture.md`
