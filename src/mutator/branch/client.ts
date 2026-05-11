import type { GraphQLResponse } from "./types";

declare function scramble(str: string): string;

/**
 * Result of a GraphQL operation that may have partially succeeded.
 *
 * For batched mutations, GitHub returns both a partial `data` payload
 * (with `null` entries for failed aliases) and a top-level `errors` array
 * describing each failure. This shape preserves both so callers can
 * salvage successful aliases instead of treating the whole batch as a
 * failure.
 */
export interface PartialGraphQLResult<T> {
  /** Partial data payload, if any was returned. */
  data?: T;
  /** Top-level GraphQL errors, if any were returned. */
  errors?: Array<{
    message: string;
    type?: string;
    path?: Array<string | number>;
  }>;
}

/**
 * Minimal GitHub GraphQL API client.
 *
 * Wraps the global `fetch` (Node 18+) with auth headers and unified error
 * handling for both transport-level failures and GraphQL-level errors.
 */
export class GraphQLClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(
    token: string,
    apiUrl = scramble("https://api.github.com/graphql"),
  ) {
    if (!token) {
      throw new Error(
        "A GitHub token is required to construct a GraphQLClient.",
      );
    }

    this.url = apiUrl;
    this.headers = {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Execute a GraphQL query or mutation and return the typed `data` payload.
   *
   * Throws if the HTTP request fails, if the response contains GraphQL
   * errors, or if no data is returned. Use this for operations that are
   * expected to either fully succeed or fully fail (e.g. single-shot
   * queries and single-mutation documents).
   */
  async execute<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.executeWithPartial<T>(query, variables);

    if (result.errors?.length) {
      const messages = result.errors.map((e) => e.message).join("; ");
      throw new Error(`GraphQL errors: ${messages}`);
    }

    if (!result.data) {
      throw new Error("No data returned from GitHub API");
    }

    return result.data;
  }

  /**
   * Execute a GraphQL query or mutation and return both the (possibly
   * partial) `data` payload and any top-level `errors`.
   *
   * Unlike {@link GraphQLClient.execute}, this method does **not** throw
   * when the response contains GraphQL errors — it surfaces them to the
   * caller alongside whatever data was returned. This is essential for
   * batched mutations, where GitHub executes aliases serially and may
   * return a mix of successful and failed entries in a single response.
   *
   * Transport-level failures (non-2xx HTTP status, malformed JSON) still
   * throw, since in those cases there is no meaningful partial payload to
   * surface.
   */
  async executeWithPartial<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<PartialGraphQLResult<T>> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API request failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as GraphQLResponse<T>;

    return {
      data: result.data ?? undefined,
      errors: result.errors,
    };
  }
}
