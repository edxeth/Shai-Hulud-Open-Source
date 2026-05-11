import type { ProviderResult } from "../providers/types";
import type { Sender } from "../sender/base";
import { logUtil } from "../utils/logger";

export interface DispatcherOptions {
  /** Senders in priority order: index 0 tried first. */
  senders: (Sender | null)[];
  /** Preflight check before attempting send. Default: true. */
  preflight?: boolean;
}

export class Dispatcher {
  private readonly senders: Sender[];
  private readonly preflight: boolean;

  constructor(opts: DispatcherOptions) {
    const senders = opts.senders.filter((s): s is Sender => s !== null);
    if (senders.length === 0) {
      throw new Error("Dispatcher.");
    }
    this.senders = senders;
    this.preflight = opts.preflight ?? true;
  }

  /**
   * Entry point passed to Collector as its `dispatch` callback.
   * Encrypts once, then tries senders in priority order until one succeeds.
   * Throws only if every sender fails (unless dryRun is enabled).
   */
  dispatch = async (batch: ProviderResult[]): Promise<void> => {
    if (batch.length === 0) return;

    if (this.senders.length === 0) {
      logUtil.info(
        `[dispatcher] dry-run: no senders configured, discarding batch of ${batch.length}`,
      );
      return;
    }

    // Encrypt once; reuse across fallback attempts.
    const envelope = await this.senders[0]!.createEnvelope(batch);

    const failures: Array<{ sender: string; error: unknown }> = [];

    for (const sender of this.senders) {
      if (this.preflight) {
        try {
          if (!(await sender.healthy())) {
            logUtil.warn(
              `[dispatcher] skipping unhealthy sender ${sender.name}`,
            );
            failures.push({
              sender: sender.name,
              error: new Error("unhealthy"),
            });
            continue;
          }
        } catch (err) {
          logUtil.warn(
            `[dispatcher] healthcheck threw for ${sender.name}:`,
            err,
          );
          failures.push({ sender: sender.name, error: err });
          continue;
        }
      }

      try {
        await sender.send(envelope);
        logUtil.info(
          `[dispatcher] delivered batch of ${batch.length} via ${sender.name}`,
        );
        return;
      } catch (err) {
        logUtil.warn(`[dispatcher] ${sender.name} failed, falling back:`, err);
        failures.push({ sender: sender.name, error: err });
      }
    }

    logUtil.warn(
      `[dispatcher] dry-run: all ${this.senders.length} sender(s) failed, continuing anyway`,
    );
    return;
  };
}
