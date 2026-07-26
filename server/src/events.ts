import type { ServerEvent } from "./types.ts";

type EventListener = (event: ServerEvent) => void;

export class EventHub {
  private sequence = 0;
  private readonly history: ServerEvent[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly historySize: number;

  constructor(historySize: number) {
    this.historySize = historySize;
  }

  publish(sessionId: string, type: ServerEvent["type"], payload: unknown): ServerEvent {
    const event: ServerEvent = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      sessionId,
      type,
      payload,
    };

    this.history.push(event);
    if (this.history.length > this.historySize) this.history.shift();

    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
    return event;
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(sessionId);
    };
  }

  since(sessionId: string, sequence: number): ServerEvent[] {
    return this.history.filter(
      (event) => event.sessionId === sessionId && event.sequence > sequence,
    );
  }
}
