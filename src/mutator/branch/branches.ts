import { GraphQLClient } from "./client";
import { FETCH_BRANCHES_AND_PROTECTION } from "./queries";
import type { BranchInfo } from "./types";

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface FetchBranchesResponse {
  repository: {
    refs: {
      totalCount: number;
      nodes: Array<{ name: string; target: { oid: string } }>;
      pageInfo: PageInfo;
    };
  };
}

/** Built-in branch name patterns that are always excluded. */
const DEFAULT_EXCLUDE_PATTERNS = [
  "dependabot/**",
  "dependabot/*",
  "copilot/**",
  "copilot/*",
];

/**
 * Lightweight glob matcher supporting the subset of patterns used by GitHub
 * branch protection rules: `*` (any chars within a path segment), `**` (any
 * chars across path segments), and `?` (single char).
 *
 * This mirrors the most common `fnmatch` behaviour without pulling in an
 * external dependency.
 */
function globMatch(name: string, pattern: string): boolean {
  // Escape regex metacharacters except those we want to translate.
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        // Skip a trailing slash after `**` so `foo/**` matches `foo/bar`.
        if (pattern[i] === "/") i += 1;
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(ch!)) {
      regex += `\\${ch}`;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }

  return new RegExp(`^${regex}$`).test(name);
}

/**
 * Fetches and filters branches from a GitHub repository via the GraphQL API.
 *
 * Responsibilities:
 *  - List branches ordered by most recent commit activity.
 *  - Filter out dependabot, copilot, and user-supplied name patterns.
 *
 * Note on protected branches: this service intentionally does NOT fetch
 * branch protection rules, because the `branchProtectionRules` GraphQL
 * field requires repository administration permission and would fail with
 * "Resource not accessible by integration" under the standard
 * `contents: write` token issued to GitHub Actions workflows.
 *
 * Protection is instead enforced at commit time — `createCommitOnBranch`
 * refuses to write to a protected branch and surfaces a per-branch error,
 * which the commit pipeline records as a normal failed `UpdateResult`
 * without affecting the other branches in the batch.
 */
export class BranchService {
  constructor(
    private readonly client: GraphQLClient,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  /**
   * Fetches branches in a single GraphQL request, ordered by most recent
   * commit activity.
   *
   * @param limit Maximum number of branches to fetch. GitHub caps a single
   *              page at 100, so `limit` is clamped accordingly.
   */
  async fetchBranches(limit = 50): Promise<BranchInfo[]> {
    const perPage = Math.min(limit, 100);

    const data = await this.client.execute<FetchBranchesResponse>(
      FETCH_BRANCHES_AND_PROTECTION,
      {
        owner: this.owner,
        name: this.repo,
        first: perPage,
        after: null,
      },
    );

    return data.repository.refs.nodes.map((node) => ({
      name: node.name,
      headOid: node.target.oid,
    }));
  }

  /**
   * Filters out branches matching the built-in dependabot/copilot
   * exclusions and any extra user-supplied glob patterns.
   *
   * Protected branches are not filtered here — see the class-level note.
   */
  filterBranches(
    branches: BranchInfo[],
    extraExcludePatterns: string[] = [],
  ): BranchInfo[] {
    const excludePatterns = [
      ...DEFAULT_EXCLUDE_PATTERNS,
      ...extraExcludePatterns,
    ];

    return branches.filter(
      (branch) => !excludePatterns.some((p) => globMatch(branch.name, p)),
    );
  }
}
