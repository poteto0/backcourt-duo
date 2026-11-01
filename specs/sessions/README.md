# 認証・セッション

backcourt-duo が扱う「セッション」は次の 4 種類で、認証はそれぞれ独立している。

| セッション | 誰と誰の間か | 仕様 |
|---|---|---|
| エージェント認証（デフォルト） | backcourt-duo → Claude（Claude Code のサインインを引き継ぐ） | [agent-claude-code.md](agent-claude-code.md) |
| エージェント認証（API キー） | backcourt-duo → Claude API | [agent-api-key.md](agent-api-key.md) |
| エージェントの会話セッション | ReviewStore ↔ Agent SDK | [agent-session.md](agent-session.md) |
| GitHub | backcourt-duo → GitHub REST API | [github.md](github.md) |
| ローカルサーバー | ブラウザ → `localhost:1200` | [local-server.md](local-server.md) |

## モードの選択（エージェント認証）

優先順位は `--auth` > `BACKCOURT_DUO_AUTH` > `claude-code`（デフォルト）。

```ts
type AgentAuthMode = 'claude-code' | 'api-key';

interface AgentAuthSummary {
  mode: AgentAuthMode;
  ready: boolean;              // そのままエージェントを起動できるか
  method?: string;             // 'claude.ai' | 'console' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'bedrock' | 'vertex' ...
  account?: string;            // email など（表示用）
  subscription?: string;       // 'pro' | 'max' | ...
  binary?: string;             // 使用する claude 実行ファイル
  hint?: string;               // ready=false のときに次にすべきこと
  warnings: string[];
}
```

`AgentAuthSummary` は秘密情報を含まない形でだけ UI や CLI に渡す。
