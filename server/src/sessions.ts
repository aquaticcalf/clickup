import { resolve } from "node:path"
import {
  createAgentSession,
  SessionManager as PiSessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent"
import { EventHub } from "./events.ts"
import type { ManagedSession, ServerConfig } from "./types.ts"

export interface CreateSessionInput {
  cwd?: string
  sessionFile?: string
}

export class SessionRegistry {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly config: ServerConfig
  private readonly events: EventHub

  constructor(config: ServerConfig, events: EventHub) {
    this.config = config
    this.events = events
  }

  list(): ManagedSession[] {
    return [...this.sessions.values()]
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id)
  }

  async create(input: CreateSessionInput = {}): Promise<ManagedSession> {
    const cwd = resolve(input.cwd ?? process.cwd())
    const sessionManager = input.sessionFile
      ? PiSessionManager.open(resolve(input.sessionFile), undefined, cwd)
      : PiSessionManager.create(cwd)

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.config.agentDir,
      sessionManager,
    })

    const managed: ManagedSession = {
      id: session.sessionId,
      cwd,
      session,
      createdAt: new Date().toISOString(),
      queue: Promise.resolve(),
    }

    session.subscribe((event) => {
      this.events.publish(managed.id, event.type, event)
    })

    this.sessions.set(managed.id, managed)
    this.events.publish(managed.id, "session_created", this.status(managed))
    return managed
  }

  async dispose(id: string): Promise<boolean> {
    const managed = this.sessions.get(id)
    if (!managed) return false

    await this.run(id, async () => {
      managed.session.dispose()
      this.events.publish(id, "session_disposed", {})
      this.sessions.delete(id)
    })
    return true
  }

  async disposeAll(): Promise<void> {
    for (const managed of this.sessions.values()) managed.session.dispose()
    this.sessions.clear()
  }

  run<T>(id: string, operation: (session: AgentSession) => Promise<T>): Promise<T> {
    const managed = this.sessions.get(id)
    if (!managed) return Promise.reject(new Error(`session not found: ${id}`))

    const result = managed.queue.then(() => operation(managed.session))
    managed.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  status(managed: ManagedSession) {
    return {
      id: managed.id,
      cwd: managed.cwd,
      createdAt: managed.createdAt,
      sessionFile: managed.session.sessionFile ?? undefined,
      sessionName: managed.session.sessionName ?? undefined,
      isStreaming: managed.session.isStreaming,
      isIdle: managed.session.isIdle,
      isBashRunning: managed.session.isBashRunning,
      model: managed.session.model
        ? {
            provider: managed.session.model.provider,
            id: managed.session.model.id,
          }
        : undefined,
      thinkingLevel: managed.session.thinkingLevel,
      activeTools: managed.session.getActiveToolNames(),
    }
  }
}
