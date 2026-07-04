/**
 * Execution log — the agent_log-style audit trail. Generalized from kredence's
 * `AgentLogger`: every meaningful step appends a structured entry so the full
 * verification run is replayable and auditable after the fact. An optional
 * `onEntry` callback lets a caller stream progress live (a dashboard, a Pulse
 * notify) exactly as kredence streamed to its WebSocket server.
 */
import type { ExecutionLogEntry, ExecutionPhase } from "./types.ts";

export type LogListener = (entry: ExecutionLogEntry) => void;

export class ExecutionLog {
  #entries: ExecutionLogEntry[] = [];
  #listener: LogListener | undefined;
  /** When true, mirror entries to the console (off by default so tests stay quiet). */
  #echo: boolean;

  constructor(options?: { onEntry?: LogListener; echo?: boolean }) {
    this.#listener = options?.onEntry;
    this.#echo = options?.echo ?? false;
  }

  log(
    level: ExecutionLogEntry["level"],
    phase: ExecutionPhase,
    action: string,
    details?: Record<string, unknown>,
  ): void {
    const entry: ExecutionLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      phase,
      action,
      ...(details ? { details } : {}),
    };
    this.#entries.push(entry);
    this.#listener?.(entry);

    if (this.#echo) {
      const prefix = `[meridian][${phase}]`;
      if (level === "error") console.error(prefix, action, details ?? "");
      else if (level === "warn") console.warn(prefix, action, details ?? "");
      else console.log(prefix, action, details ?? "");
    }
  }

  /** Immutable snapshot of everything logged so far. */
  entries(): ExecutionLogEntry[] {
    return [...this.#entries];
  }
}
