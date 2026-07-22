import { Client, type Notification } from "pg";
import type {
  StoredSnapshotJobAttempt,
  StoredSnapshotJobEvent,
} from "./workspace-repository.js";

export interface SnapshotJobHistoryReader {
  listSnapshotJobEvents(
    jobId: string,
    afterEventId?: number | string,
    limit?: number,
  ): Promise<StoredSnapshotJobEvent[]>;
  getLatestSnapshotJobEvent(jobId: string): Promise<StoredSnapshotJobEvent | null>;
  listSnapshotJobAttempts(
    jobId: string,
    options?: { limit?: number; before?: number | string },
  ): Promise<StoredSnapshotJobAttempt[]>;
}

/**
 * Optional low-latency signal for a durable event feed. Implementations may
 * drop or duplicate signals because consumers always replay from history.
 */
export interface SnapshotJobEventWakeup {
  subscribe(jobId: string, listener: () => void): () => void;
  close(): Promise<void>;
}

export interface SnapshotJobEventBatch {
  events: StoredSnapshotJobEvent[];
  caughtUp: boolean;
}

export interface SnapshotJobEventFeedOptions {
  history: SnapshotJobHistoryReader;
  wakeup?: SnapshotJobEventWakeup;
  pollIntervalMs?: number;
  batchSize?: number;
}

export class SnapshotJobEventFeed {
  private readonly history: SnapshotJobHistoryReader;
  private readonly wakeup?: SnapshotJobEventWakeup;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;

  constructor(options: SnapshotJobEventFeedOptions) {
    this.history = options.history;
    this.wakeup = options.wakeup;
    this.pollIntervalMs = Math.max(
      100,
      Math.min(60_000, Math.floor(options.pollIntervalMs ?? 1_000)),
    );
    this.batchSize = Math.max(
      1,
      Math.min(500, Math.floor(options.batchSize ?? 100)),
    );
  }

  async *watch(
    jobId: string,
    afterEventId: string,
    signal: AbortSignal,
  ): AsyncGenerator<SnapshotJobEventBatch> {
    let cursor = afterEventId;
    let wakePending = false;
    let wakeResolver: (() => void) | null = null;
    const unsubscribe = this.wakeup?.subscribe(jobId, () => {
      wakePending = true;
      wakeResolver?.();
    });
    try {
      while (!signal.aborted) {
        const events = await this.history.listSnapshotJobEvents(
          jobId,
          cursor,
          this.batchSize,
        );
        if (events.length) cursor = events[events.length - 1].eventId;
        const caughtUp = events.length < this.batchSize;
        yield { events, caughtUp };
        if (!caughtUp || signal.aborted) continue;
        if (wakePending) {
          wakePending = false;
          continue;
        }
        await new Promise<void>((resolve) => {
          let settled = false;
          const timer = setTimeout(finish, this.pollIntervalMs);
          timer.unref();
          const onAbort = (): void => finish();
          function finish(): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve();
          }
          wakeResolver = finish;
          signal.addEventListener("abort", onAbort, { once: true });
          if (wakePending) finish();
        });
        wakeResolver = null;
        wakePending = false;
      }
    } finally {
      unsubscribe?.();
    }
  }
}

export interface PostgresSnapshotJobEventWakeupOptions {
  databaseUrl: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

/** A multiplexed LISTEN connection; polling in SnapshotJobEventFeed is the fallback. */
export class PostgresSnapshotJobEventWakeup implements SnapshotJobEventWakeup {
  private readonly databaseUrl: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly listeners = new Map<string, Set<() => void>>();
  private client: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private connecting = false;
  private closed = false;

  constructor(options: PostgresSnapshotJobEventWakeupOptions) {
    this.databaseUrl = options.databaseUrl;
    this.reconnectBaseMs = Math.max(
      100,
      Math.min(30_000, Math.floor(options.reconnectBaseMs ?? 250)),
    );
    this.reconnectMaxMs = Math.max(
      this.reconnectBaseMs,
      Math.min(60_000, Math.floor(options.reconnectMaxMs ?? 5_000)),
    );
    this.startConnect();
  }

  subscribe(jobId: string, listener: () => void): () => void {
    let listeners = this.listeners.get(jobId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(jobId, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return (): void => {
      if (!subscribed) return;
      subscribed = false;
      listeners!.delete(listener);
      if (!listeners!.size) this.listeners.delete(jobId);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.listeners.clear();
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.closed || this.connecting || this.client || this.reconnectTimer) return;
    const delay = delayMs ?? Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempts, 8),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startConnect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private startConnect(): void {
    void this.connect().catch(() => {
      this.connecting = false;
      this.client = null;
      if (!this.closed) {
        this.reconnectAttempts += 1;
        this.scheduleReconnect();
      }
    });
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting || this.client) return;
    this.connecting = true;
    const client = new Client({
      connectionString: this.databaseUrl,
      application_name: "contextengine-snapshot-events",
    });
    let disconnected = false;
    const disconnect = (): void => {
      if (disconnected) return;
      disconnected = true;
      if (this.client === client) this.client = null;
      this.connecting = false;
      if (!this.closed) {
        this.reconnectAttempts += 1;
        this.scheduleReconnect();
      }
      void client.end().catch(() => undefined);
    };
    const onNotification = (message: Notification): void => {
      if (message.channel !== "ce_snapshot_job_events" || !message.payload) return;
      for (const listener of this.listeners.get(message.payload) ?? []) {
        try {
          listener();
        } catch {
          // A wakeup is best effort; one subscriber must not break the hub.
        }
      }
    };
    client.on("notification", onNotification);
    client.on("error", disconnect);
    client.on("end", disconnect);
    this.client = client;
    try {
      await client.connect();
      await client.query("LISTEN ce_snapshot_job_events");
      if (this.closed) {
        await client.end().catch(() => undefined);
        return;
      }
      this.connecting = false;
      this.reconnectAttempts = 0;
    } catch {
      disconnect();
      await client.end().catch(() => undefined);
    }
  }
}
