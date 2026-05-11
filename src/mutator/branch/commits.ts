import { GraphQLClient } from "./client";
import {
  BATCHED_COMMIT_ALIAS_PREFIX,
  BATCHED_COMMIT_VARIABLE_PREFIX,
  buildBatchedCommitMutation,
  CREATE_COMMIT_ON_BRANCH,
} from "./queries";
import type { BranchCommit, FileChange, UpdateResult } from "./types";

/**
 * Shape of the `data` payload returned by a batched
 * `createCommitOnBranch` mutation. Each alias key (e.g. "b0", "b1", ...)
 * maps to either a successful commit object or `null` if that particular
 * commit failed.
 */
type BatchedCommitData = Record<
  string,
  { commit: { oid: string; url: string } } | null
>;

/**
 * Shape of an individual error entry returned alongside a partial-failure
 * batched mutation response.
 */
interface GraphQLErrorEntry {
  message: string;
  path?: Array<string | number>;
}

/**
 * Creates commits on a GitHub repository via the GraphQL API.
 *
 * Uses the `createCommitOnBranch` mutation, which produces signed commits
 * attributed to the authenticated user/app without requiring a local
 * git working tree.
 *
 * Two flavours are exposed:
 *
 *  - {@link CommitService.pushFileUpdates} — single branch, single HTTP call.
 *  - {@link CommitService.pushBatchedFileUpdates} — many branches, single
 *    HTTP call (mutations execute serially on the server, but HTTP and
 *    auth overhead are paid only once).
 */
export class CommitService {
  constructor(
    private readonly client: GraphQLClient,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  /**
   * Creates a single commit on the given branch that adds/updates one or
   * more files atomically.
   *
   * All file changes are applied in a single commit — either every file is
   * written successfully or the commit fails as a whole.
   *
   * @param branchName       The branch to commit to (e.g. "main").
   * @param expectedHeadOid  The current HEAD OID of the branch — used by
   *                         GitHub for optimistic concurrency control.
   * @param files            One or more files to add/update. Each entry's
   *                         `path` is the repository-relative path
   *                         (including any directories), and `content` is
   *                         the UTF-8 file content (will be base64-encoded).
   * @param commitHeadline   Commit message headline.
   * @param commitBody       Optional commit message body. Useful for
   *                         `Co-authored-by:` trailers, which GitHub
   *                         renders as additional authors on the commit
   *                         page.
   */
  async pushFileUpdates(
    branchName: string,
    expectedHeadOid: string,
    files: FileChange[],
    commitHeadline: string,
    commitBody?: string,
  ): Promise<UpdateResult> {
    if (files.length === 0) {
      return {
        branch: branchName,
        success: false,
        error: "No file changes provided.",
      };
    }

    try {
      const additions = this.buildAdditions(files);

      const data = await this.client.execute<{
        createCommitOnBranch: {
          commit: { oid: string; url: string };
        };
      }>(CREATE_COMMIT_ON_BRANCH, {
        input: {
          branch: {
            repositoryNameWithOwner: `${this.owner}/${this.repo}`,
            branchName,
          },
          message: {
            headline: commitHeadline,
            ...(commitBody ? { body: commitBody } : {}),
          },
          fileChanges: { additions },
          expectedHeadOid,
        },
      });

      return {
        branch: branchName,
        success: true,
        commitOid: data.createCommitOnBranch.commit.oid,
      };
    } catch (error) {
      return {
        branch: branchName,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Creates commits across multiple branches in a single batched GraphQL
   * mutation document.
   *
   * Per the GraphQL spec, mutations within one document execute serially
   * on the server, so this does **not** parallelise the underlying commits;
   * it only saves HTTP round-trips and per-request auth overhead. If any
   * individual commit fails, GitHub returns `null` for that alias and adds
   * a `path: ["b<index>"]` entry to the top-level errors array, while
   * continuing to execute the remaining aliases.
   *
   * Every commit produces exactly one {@link UpdateResult}; the returned
   * array preserves the order of `commits`.
   *
   * @param commits  One commit job per branch. Must not be empty.
   */
  async pushBatchedFileUpdates(
    commits: BranchCommit[],
  ): Promise<UpdateResult[]> {
    if (commits.length === 0) {
      return [];
    }

    // Validate each commit job up front so callers get a stable
    // result-per-input mapping even if some inputs are obviously invalid.
    const results: UpdateResult[] = new Array(commits.length);
    const dispatchIndices: number[] = [];
    const dispatchCommits: BranchCommit[] = [];

    commits.forEach((commit, index) => {
      if (commit.files.length === 0) {
        results[index] = {
          branch: commit.branchName,
          success: false,
          error: "No file changes provided.",
        };
        return;
      }
      dispatchIndices.push(index);
      dispatchCommits.push(commit);
    });

    if (dispatchCommits.length === 0) {
      return results;
    }

    const query = buildBatchedCommitMutation(dispatchCommits.length);
    const variables: Record<string, unknown> = {};

    dispatchCommits.forEach((commit, i) => {
      variables[`${BATCHED_COMMIT_VARIABLE_PREFIX}${i}`] = {
        branch: {
          repositoryNameWithOwner: `${this.owner}/${this.repo}`,
          branchName: commit.branchName,
        },
        message: {
          headline: commit.commitHeadline,
          ...(commit.commitBody ? { body: commit.commitBody } : {}),
        },
        fileChanges: { additions: this.buildAdditions(commit.files) },
        expectedHeadOid: commit.expectedHeadOid,
      };
    });

    let data: BatchedCommitData | undefined;
    let topLevelErrors: GraphQLErrorEntry[] | undefined;

    try {
      // Use executeWithPartial so that successful aliases are still
      // available even when some entries in the batch fail. GitHub
      // executes batched mutations serially and returns a mix of
      // commit objects and `null`s alongside per-alias error entries.
      const result = await this.client.executeWithPartial<BatchedCommitData>(
        query,
        variables,
      );
      data = result.data;
      topLevelErrors = result.errors;
    } catch (error) {
      // Transport-level failure (non-2xx HTTP, malformed JSON, network
      // error). No partial data is recoverable, so every dispatched
      // commit is marked failed with the same message.
      const message = error instanceof Error ? error.message : String(error);
      topLevelErrors = [{ message }];
      data = undefined;
    }

    dispatchCommits.forEach((commit, i) => {
      const resultIndex = dispatchIndices[i]!;
      const aliasKey = `${BATCHED_COMMIT_ALIAS_PREFIX}${i}`;

      if (data) {
        const aliasResult = data[aliasKey];
        if (aliasResult && aliasResult.commit) {
          results[resultIndex] = {
            branch: commit.branchName,
            success: true,
            commitOid: aliasResult.commit.oid,
          };
          return;
        }
      }

      results[resultIndex] = {
        branch: commit.branchName,
        success: false,
        error: extractAliasError(aliasKey, topLevelErrors),
      };
    });

    return results;
  }

  /**
   * Splits a list of commit jobs into evenly-sized chunks and dispatches
   * each chunk via {@link CommitService#pushBatchedFileUpdates}.
   *
   * Chunking keeps each batched mutation document well below GitHub's
   * query-complexity and document-size limits and bounds the blast radius
   * of any single transport-level failure.
   *
   * Chunks are dispatched **sequentially** so the caller can rely on a
   * stable, ordered result stream and so we don't trigger secondary rate
   * limits with bursts of concurrent requests.
   *
   * @param commits   One commit job per branch.
   * @param chunkSize Maximum number of commit jobs per batched mutation.
   *                  Defaults to 10. Must be >= 1.
   * @param onChunk   Optional callback invoked with each chunk's results
   *                  as soon as the chunk completes — useful for
   *                  streaming progress to the user.
   */
  async pushChunkedFileUpdates(
    commits: BranchCommit[],
    chunkSize = 10,
    onChunk?: (chunkResults: UpdateResult[]) => void,
  ): Promise<UpdateResult[]> {
    if (chunkSize < 1) {
      throw new Error(
        `pushChunkedFileUpdates requires chunkSize >= 1, got ${chunkSize}.`,
      );
    }

    const all: UpdateResult[] = [];

    for (let i = 0; i < commits.length; i += chunkSize) {
      const chunk = commits.slice(i, i + chunkSize);
      const chunkResults = await this.pushBatchedFileUpdates(chunk);
      all.push(...chunkResults);
      if (onChunk) onChunk(chunkResults);
    }

    return all;
  }

  /**
   * Translates a list of {@link FileChange}s into the `additions` array
   * shape expected by `createCommitOnBranch.fileChanges`.
   */
  private buildAdditions(
    files: FileChange[],
  ): Array<{ path: string; contents: string }> {
    return files.map((file) => ({
      path: file.path,
      // Honour the `preEncoded` flag set by binary file sources: if the
      // content is already base64-encoded for transport, pass it through
      // verbatim. Otherwise treat it as UTF-8 text and encode it now.
      contents: file.preEncoded
        ? file.content
        : Buffer.from(file.content, "utf-8").toString("base64"),
    }));
  }
}

/**
 * Picks the GraphQL error entry whose `path` points at the given alias
 * (e.g. `["b3"]`) and returns its message. Falls back to the first error's
 * message, or a generic placeholder if none is available.
 */
function extractAliasError(
  aliasKey: string,
  errors: GraphQLErrorEntry[] | undefined,
): string {
  if (!errors || errors.length === 0) {
    return "Commit failed (no error detail returned).";
  }

  const matching = errors.find(
    (err) =>
      Array.isArray(err.path) &&
      err.path.some((segment) => segment === aliasKey),
  );

  return (matching ?? errors[0]!).message;
}
