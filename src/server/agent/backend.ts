// The surface the HTTP layer uses for whichever agent runtime is selected (specs/sessions/agent-session.md).
import type { ChatMessage, EffortLevel } from '../../shared/types.js';

export interface AgentRuntime {
  /** Accepting messages (the Claude query is open, or OpenCode is authenticated and started). */
  readonly running: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  sendHuman(text: string): ChatMessage;
  setModel(model: string): Promise<void>;
  /** null goes back to the model's default. Backends without effort control accept it as a no-op. */
  setEffort(effort: EffortLevel | null): Promise<void>;
  interrupt(): Promise<void>;
  signIn(): Promise<void>;
}
