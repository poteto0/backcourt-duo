# コマンド一覧

| コマンド | 仕様 | 概要 |
|---|---|---|
| `backcourt-duo [start]` | [start.md](start.md) | サーバーを起動し、diff・チャット・Submit の UI を開く |
| `backcourt-duo auth status\|login\|logout` | [auth.md](auth.md) | Claude と GitHub の認証の確認とサインイン |
| `backcourt-duo doctor` | [doctor.md](doctor.md) | 起動前チェック |
| `backcourt-duo --help` / `--version` | — | ヘルプとバージョン |

共通の約束:
- 引数は `node:util` の `parseArgs` で解釈する。未知のオプションはエラーにする（exit 64）
- `-C, --cwd <dir>` はすべてのコマンドで使える
- 環境変数は `BACKCOURT_DUO_PORT`、`BACKCOURT_DUO_AUTH`、`BACKCOURT_DUO_MODEL`、`BACKCOURT_DUO_CLAUDE_PATH` を読む。コマンドラインの指定がある場合はそちらを優先する
- 色付き出力は TTY のときだけ行う。`NO_COLOR` が設定されていれば色を付けない
