import type { ConnectorSyncCoordinator } from "./connector-sync.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

export interface ConnectorWebhookProcessorOptions {
  repository: WorkspaceRepository;
  coordinator: Pick<ConnectorSyncCoordinator, "sync">;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

/** Persistent at-least-once webhook worker; connector cursor commits remain idempotent. */
export class ConnectorWebhookProcessor {
  private readonly repository: WorkspaceRepository;
  private readonly coordinator: Pick<ConnectorSyncCoordinator, "sync">;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private stopped = true;

  constructor(options: ConnectorWebhookProcessorOptions) {
    this.repository = options.repository;
    this.coordinator = options.coordinator;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    if (
      !Number.isInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 100 ||
      this.pollIntervalMs > 60_000
    ) {
      throw new Error("Webhook poll interval must be from 100 to 60000 milliseconds");
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 20) {
      throw new Error("Webhook max attempts must be from 1 to 20");
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.notify(), this.pollIntervalMs);
    this.timer.unref();
    this.notify();
  }

  notify(): void {
    if (this.stopped || this.draining) return;
    this.draining = this.drain()
      .catch((error: unknown) => {
        console.error(
          "[connector webhook] worker failed:",
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        this.draining = null;
      });
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.draining;
  }

  private async drain(): Promise<void> {
    for (let processed = 0; !this.stopped && processed < 32; processed++) {
      const [event] = await this.repository.claimConnectorWebhookEvents(1);
      if (!event) return;
      const source = await this.repository.getConnectorSourceById(event.sourceId);
      if (!source) continue;
      try {
        const sync = await this.coordinator.sync(source.workspaceId, source.id);
        const provenance = event.metadata
          ? { ci_provenance: event.metadata }
          : {};
        await this.repository.completeConnectorWebhookEvent(
          source.id,
          event.eventId,
          event.attempts,
          {
            ...provenance,
            noop: sync.noop,
            revision: sync.revision,
            changed_paths: sync.changedPaths,
            deleted_paths: sync.deletedPaths,
            index_job_id: sync.indexJob?.id ?? null,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const delay = Math.min(60_000, 1_000 * 2 ** Math.min(event.attempts - 1, 6));
        await this.repository.retryConnectorWebhookEvent(
          event.sourceId,
          event.eventId,
          event.attempts,
          message,
          delay,
          this.maxAttempts,
        );
      }
    }
  }
}
