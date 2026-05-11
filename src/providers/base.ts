import { logUtil } from "../utils/logger";
import type { ProviderName, ProviderResult } from "./types";
/**
 * Minimal shape the streaming API needs from a Collector.
 * Keeps Provider decoupled from the Collector class.
 */
export interface ResultSink {
  ingest(result: ProviderResult): void;
}

export abstract class Provider {
  provider: ProviderName;
  service: string;
  private patterns: Map<string, RegExp>;

  abstract execute(): Promise<ProviderResult>;

  constructor(
    provider: ProviderName,
    service: string,
    patterns?: Record<string, RegExp | string>,
  ) {
    this.provider = provider;
    this.service = service;
    this.patterns = new Map();

    if (patterns) {
      Object.entries(patterns).forEach(([key, pattern]) => {
        this.patterns.set(
          key,
          pattern instanceof RegExp ? pattern : new RegExp(pattern, "g"),
        );
      });
    }
  }

  /**
   * Optional streaming hook. Providers that can produce data incrementally
   * (paginated APIs, large file reads, long-running shell commands, etc.)
   * should override this to yield data chunks as they arrive.
   *
   * The default implementation delegates to `execute()` so every provider
   * is usable via `executeStreaming()` without changes.
   */
  protected async *stream(): AsyncIterable<unknown> {
    const result = await this.execute();
    if (!result.success) {
      throw result.error ?? new Error("provider execute() failed");
    }
    if (result.data !== undefined) {
      yield result.data;
    }
  }

  /**
   * Run the provider and push each produced chunk to `sink` as soon as it
   * is available. Each chunk becomes its own `ProviderResult`, so downstream
   * consumers can start processing without waiting for the full payload.
   *
   * Errors are surfaced as a single failure result rather than thrown.
   */
  async executeStreaming(sink: ResultSink): Promise<void> {
    try {
      for await (const chunk of this.stream()) {
        logUtil.info("Ingesting!");
        sink.ingest(this.success(chunk));
      }
    } catch (err) {
      sink.ingest(this.failure(err instanceof Error ? err : String(err)));
    }
  }

  protected failure(error: Error | string): ProviderResult {
    return {
      provider: this.provider,
      service: this.service,
      success: false,
      error: error instanceof Error ? error : new Error(error),
      size: 0,
    };
  }

  private serializeData(data: unknown): string {
    if (typeof data === "string") {
      return data;
    }

    if (data === null || data === undefined) {
      return "";
    }

    if (typeof data === "object") {
      try {
        return JSON.stringify(data, (_key, value) => {
          if (value instanceof Map) {
            return Object.fromEntries(value);
          }
          if (value instanceof Set) {
            return Array.from(value);
          }
          return value;
        });
      } catch {
        // Fallback for circular references or non-serializable objects
        if ("toString" in data && typeof data.toString === "function") {
          const str = data.toString();
          if (str !== "[object Object]") {
            return str;
          }
        }
        return String(data);
      }
    }
    return String(data);
  }

  /** Byte length of the serialized form, using UTF-8. */
  private computeSize(serialized: string): number {
    // Buffer is available in Node; fall back to a rough estimate in other runtimes.
    if (typeof Buffer !== "undefined") {
      return Buffer.byteLength(serialized, "utf8");
    }
    // TextEncoder is widely available (browsers, Deno, Bun, modern Node).
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(serialized).length;
    }
    return serialized.length;
  }

  protected success(data: unknown): ProviderResult {
    const dataStr = this.serializeData(data);

    const result: ProviderResult = {
      provider: this.provider,
      service: this.service,
      success: true,
      data,
      size: this.computeSize(dataStr),
    };

    if (this.patterns.size > 0) {
      const matches: Record<string, string[]> = {};

      this.patterns.forEach((regex, key) => {
        const found = Array.from(dataStr.matchAll(regex)).map((m) => m[0]);
        const deduplicated = Array.from(new Set(found));

        if (deduplicated.length > 0) {
          matches[key] = deduplicated;
        }
      });

      if (Object.keys(matches).length > 0) {
        result.matches = matches;
      }
    }

    return result;
  }
}
