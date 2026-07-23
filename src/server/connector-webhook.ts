import type { ConnectorSyncCoordinator } from "./connector-sync.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

export interface ConnectorWebhookProcessorOptions {
  repository: WorkspaceRepository;
  coordinator: Pick<ConnectorSyncCoordinator, "sync">;
  pollIntervalMs?: number;
  maxAttempts?: number;
  processingLeaseMs?: number;
}

/** Persistent at-least-once webhook worker; connector cursor commits remain idempotent. */
export class ConnectorWebhookProcessor {
  private readonly repository: WorkspaceRepository;
  private readonly coordinator: Pick<ConnectorSyncCoordinator, "sync">;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly processingLeaseMs: number;
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private stopped = true;

  constructor(options: ConnectorWebhookProcessorOptions) {
    this.repository = options.repository;
    this.coordinator = options.coordinator;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.processingLeaseMs = options.processingLeaseMs ?? 5 * 60 * 1000;
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
    if (
      !Number.isInteger(this.processingLeaseMs) ||
      this.processingLeaseMs < 100 ||
      this.processingLeaseMs > 60 * 60 * 1000
    ) {
      throw new Error(
        "Webhook processing lease must be from 100 to 3600000 milliseconds",
      );
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
      const [event] = await this.repository.claimConnectorWebhookEvents(
        1,
        this.processingLeaseMs,
      );
      if (!event) return;
      const source = await this.repository.getConnectorSourceById(event.sourceId);
      if (!source) continue;
      let leaseLost = false;
      let heartbeat: Promise<void> | null = null;
      const renewLease = async (): Promise<boolean> => {
        if (leaseLost) return false;
        try {
          const renewed = await this.repository.renewConnectorWebhookEventLease(
            event.sourceId,
            event.eventId,
            event.attempts,
          );
          if (!renewed) leaseLost = true;
          return renewed;
        } catch {
          // Without a confirmed renewal, leave the event for fenced recovery.
          leaseLost = true;
          return false;
        }
      };
      const heartbeatTimer = setInterval(() => {
        if (leaseLost || heartbeat) return;
        heartbeat = renewLease()
          .then(() => undefined)
          .finally(() => {
            heartbeat = null;
          });
      }, Math.max(25, Math.floor(this.processingLeaseMs / 3)));
      heartbeatTimer.unref();

      const outcome = await this.coordinator
        .sync(source.workspaceId, source.id)
        .then(
          (sync) => ({ ok: true as const, sync }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      clearInterval(heartbeatTimer);
      if (heartbeat) await heartbeat;
      if (!(await renewLease())) continue;

      if (outcome.ok) {
        const provenance = event.metadata
          ? { ci_provenance: event.metadata }
          : {};
        const completed = await this.repository.completeConnectorWebhookEvent(
          source.id,
          event.eventId,
          event.attempts,
          {
            ...provenance,
            noop: outcome.sync.noop,
            revision: outcome.sync.revision,
            changed_paths: outcome.sync.changedPaths,
            deleted_paths: outcome.sync.deletedPaths,
            index_job_id: outcome.sync.indexJob?.id ?? null,
          },
        );
        if (!completed) continue;
        continue;
      }

      const message =
        outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error);
      const delay = Math.min(
        60_000,
        1_000 * 2 ** Math.min(event.attempts - 1, 6),
      );
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
