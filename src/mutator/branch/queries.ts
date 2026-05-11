/**
 * Read query: fetches branches ordered by most recent commit activity.
 *
 * Note: this query intentionally does NOT include `branchProtectionRules`.
 * That field requires repository administration permission (the
 * `administration: read` scope on a GitHub App installation token, or
 * admin access for a PAT) and would cause the entire query to fail with
 * "Resource not accessible by integration" when run under the standard
 * `contents: write` token issued to GitHub Actions workflows.
 *
 * Protected branches are instead handled at commit time: the
 * `createCommitOnBranch` mutation refuses to write to a protected branch
 * and surfaces a per-branch error, which we record as a normal failed
 * `UpdateResult` without affecting the other branches in the batch.
 */
export const FETCH_BRANCHES_AND_PROTECTION = `
  query FetchBranches(
    $owner: String!
    $name: String!
    $first: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      refs(
        refPrefix: "refs/heads/"
        first: $first
        after: $after
        orderBy: { field: TAG_COMMIT_DATE, direction: DESC }
      ) {
        totalCount
        nodes {
          name
          target {
            ... on Commit {
              oid
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

/**
 * Single-branch commit mutation. Retained for callers that want to push to
 * exactly one branch without the overhead of building a batched document.
 */
export const CREATE_COMMIT_ON_BRANCH = `
  mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) {
      commit {
        oid
        url
      }
    }
  }
`;

/**
 * Builds a batched mutation document that calls `createCommitOnBranch`
 * once per branch in `aliases`, all within a single HTTP request.
 *
 * Each alias is rendered as `b<index>: createCommitOnBranch(input: $input<index>)`
 * with a matching `$input<index>: CreateCommitOnBranchInput!` parameter, so the
 * caller's `variables` object should be shaped:
 *
 *   { input0: { ... }, input1: { ... }, ... }
 *
 * Note on semantics: per the GraphQL spec, mutations within one document
 * execute **serially** on the server. Batching saves HTTP round-trips and
 * connection overhead but does not parallelise the underlying commits.
 *
 * If any individual commit fails, GitHub returns `null` for that alias and
 * appends an entry to the top-level `errors` array with `path: ["b<index>"]`,
 * while continuing to execute the remaining aliases.
 *
 * @param aliasCount Number of `createCommitOnBranch` calls to embed in the
 *                   document. Must be >= 1.
 */
export function buildBatchedCommitMutation(aliasCount: number): string {
  if (aliasCount < 1) {
    throw new Error(
      `buildBatchedCommitMutation requires aliasCount >= 1, got ${aliasCount}.`,
    );
  }

  const params: string[] = [];
  const body: string[] = [];

  for (let i = 0; i < aliasCount; i += 1) {
    params.push(`$input${i}: CreateCommitOnBranchInput!`);
    body.push(
      `    b${i}: createCommitOnBranch(input: $input${i}) {\n` +
        `      commit {\n` +
        `        oid\n` +
        `        url\n` +
        `      }\n` +
        `    }`,
    );
  }

  return `mutation BatchedCreateCommitOnBranch(\n  ${params.join(
    "\n  ",
  )}\n) {\n${body.join("\n")}\n}\n`;
}

/** Alias prefix used by `buildBatchedCommitMutation` for each commit call. */
export const BATCHED_COMMIT_ALIAS_PREFIX = "b";

/** Variable-name prefix used by `buildBatchedCommitMutation` for each input. */
export const BATCHED_COMMIT_VARIABLE_PREFIX = "input";
