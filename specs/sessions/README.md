# 認証・セッション

backcourt-duo が扱う「セッション」は次の 5 種類で、認証はそれぞれ独立している。

| セッション | 誰と誰の間か | 仕様 |
|---|---|---|
| エージェント認証（デフォルト） | backcourt-duo → Claude（Claude Code のサインインを引き継ぐ） | [agent-claude-code.md](agent-claude-code.md) |
| エージェント認証（API キー） | backcourt-duo → Claude API | [agent-api-key.md](agent-api-key.md) |
| エージェント認証（OpenCode） | backcourt-duo → OpenCode（OpenCode 自身のサインインを引き継ぐ） | [agent-opencode.md](agent-opencode.md) |
| エージェントの会話セッション | ReviewStore ↔ Agent SDK / OpenCode | [agent-session.md](agent-session.md) |
| GitHub | backcourt-duo → GitHub REST API | [github.md](github.md) |
| ローカルサーバー | ブラウザ → `localhost:1200` | [local-server.md](local-server.md) |

## バックエンドの選択

```
--agent <name> > BACKCOURT_DUO_AGENT > 設定ファイルの agent.backend > claude
```

- `claude`（デフォルト）または `opencode`。`--agent` で指定すると次回以降の既定として保存される（#48）
- どちらのバックエンドも状態の正は `ReviewStore` で、duo のツールは同じ定義を使う。
  Claude は in-process の MCP サーバー、OpenCode は `/mcp` の Streamable HTTP で同じツールに届く
- 会話セッション ID はバックエンドごとに分けて保存し、違うバックエンドの ID を resume しない

## モードの選択（Claude のエージェント認証）

Claude のときの優先順位は `--auth` > `BACKCOURT_DUO_AUTH` > `claude-code`（デフォルト）。

```ts
type AgentAuthMode = 'claude-code' | 'api-key';

interface AgentAuthSummary {
  mode: AgentAuthMode | 'opencode';
  ready: boolean;              // そのままエージェントを起動できるか
  method?: string;             // 'claude.ai' | 'console' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'bedrock' | 'vertex' ...
  account?: string;            // email など（表示用）
  subscription?: string;       // 'pro' | 'max' | ...
  binary?: string;             // 使用する claude / opencode 実行ファイル
  hint?: string;               // ready=false のときに次にすべきこと
  warnings: string[];
}
```

`AgentAuthSummary` は秘密情報を含まない形でだけ UI や CLI に渡す。
