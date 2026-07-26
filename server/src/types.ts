import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface ServerEvent {
  sequence: number;
  timestamp: string;
  sessionId: string;
  type: AgentSessionEvent["type"] | "session_created" | "session_disposed";
  payload: unknown;
}

export interface ManagedSession {
  id: string;
  cwd: string;
  session: AgentSession;
  createdAt: string;
  queue: Promise<void>;
}

export interface ServerConfig {
  host: string;
  port: number;
  agentDir?: string;
  authToken?: string;
  eventHistorySize: number;
}
