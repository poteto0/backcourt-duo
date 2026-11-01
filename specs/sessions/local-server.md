# ローカルサーバーのセッション

`localhost:1200` は認証された人間の操作で PR にコメントを投稿できるので、同じマシン上の他のサイトやプロセスから勝手に使われないよう保護する。

## バインド

- デフォルトは `127.0.0.1:1200`。`--host` にはループバック（`127.0.0.1`、`::1`、`localhost`）だけを受け付ける
- ポートが使用中なら終了する（exit 3）。別のポートを自動で探すことはしない（URL を固定しておくため）

## セッショントークン

- 起動ごとに `crypto.randomBytes(32)` で生成する（base64url）。ディスクには書かない
- 起動時に開く URL は `http://localhost:<port>/?token=<token>`
- `GET /?token=…` が一致したら、`Set-Cookie: bd_session=<token>; HttpOnly; SameSite=Strict; Path=/` を返して `/` にリダイレクトする（URL からトークンを消すため）
- `/api/*` は、Cookie の `bd_session` か `Authorization: Bearer <token>` のどちらかが一致しないと 401 を返す。比較には `timingSafeEqual` を使う
- 静的アセット（`/assets/*`）はトークンなしで配信する。中身は公開されても問題ないものだけにする
- トークンなしで `/` にアクセスした場合は「ターミナルに表示された URL を開いてください」というページを返す

## DNS rebinding と CSRF への対策

- `Host` ヘッダーが `localhost:<port>`、`127.0.0.1:<port>`、`[::1]:<port>` のどれでもなければ 421 を返す
- 状態を変更するリクエスト（POST / PUT / PATCH / DELETE）は `Origin` が上記のどれかと一致する場合だけ受け付ける（Origin がない場合も拒否する）
- `Content-Type: application/json` を必須にする

## SSE

- `GET /api/events` も同じ認証で保護する
- 接続時に `hello`（サーバーのバージョンと起動 ID）と `state` を送る。15 秒ごとに keep-alive コメントを送る
- クライアントは切断されたら指数バックオフで再接続する。起動 ID が変わっていたらページ全体をリロードする
