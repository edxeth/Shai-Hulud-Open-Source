export interface BranchInfo {
  name: string;
  headOid: string;
}

/**
 * A single file write to apply on a branch.
 *
 * @property path     Repository-relative path including any directories
 *                    (e.g. "README.md", "config/license.txt").
 * @property content  UTF-8 file content. Will be base64-encoded before being
 *                    sent to the GitHub GraphQL API.
 */
export interface FileChange {
  path: string;
  content: string;
  /**
   * When true, `content` is already base64-encoded and ready for transport
   * to the GitHub GraphQL API. The commit pipeline will skip its own
   * base64 step for this entry.
   *
   * Used by binary file sources loaded from disk, where re-encoding the
   * raw bytes as UTF-8 would corrupt them.
   */
  preEncoded?: boolean;
}

/**
 * Declarative description of where a file's contents come from.
 *
 * Either supply the content inline (`{ content: "..." }`), or point at a
 * local file on disk that should be read at runtime (`{ sourcePath: "..." }`).
 * Exactly one of `content` or `sourcePath` must be provided.
 *
 * @property content     UTF-8 file content, supplied inline.
 * @property sourcePath  Path on the local filesystem to read the file
 *                       contents from. Resolved relative to the current
 *                       working directory unless absolute. The file is
 *                       read as UTF-8.
 * @property encoding    Optional encoding override when reading from disk.
 *                       Defaults to "utf-8". Use "binary" / "base64" for
 *                       non-text files (the loader will base64-encode
 *                       binary content directly without a UTF-8 round-trip).
 */
export type FileSource =
  | { content: string; sourcePath?: never; encoding?: never }
  | {
      sourcePath: string;
      content?: never;
      encoding?: "utf-8" | "binary" | "base64";
    };

/**
 * A single per-branch commit job, used as input to a batched
 * `createCommitOnBranch` mutation.
 *
 * @property branchName       The branch to commit to.
 * @property expectedHeadOid  The branch's current HEAD OID, used by GitHub
 *                            for optimistic concurrency control.
 * @property files            One or more files to add/update in the commit.
 * @property commitHeadline   Commit message headline.
 * @property commitBody       Optional commit message body. Useful for
 *                            including `Co-authored-by:` trailers, which
 *                            GitHub renders as additional authors on the
 *                            commit page.
 */
export interface BranchCommit {
  branchName: string;
  expectedHeadOid: string;
  files: FileChange[];
  commitHeadline: string;
  commitBody?: string;
}

export interface ProtectionRule {
  pattern: string;
}

export interface UpdateResult {
  branch: string;
  success: boolean;
  commitOid?: string;
  error?: string;
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; type?: string; path?: string[] }>;
}

export interface RepoContext {
  owner: string;
  repo: string;
}
