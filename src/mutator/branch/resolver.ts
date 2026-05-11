import type { RepoContext } from "./types";

/**
 * Resolves the owner/repo from standard GitHub Actions environment variables.
 *
 * GitHub Actions automatically sets:
 *   - GITHUB_REPOSITORY         e.g. "octocat/hello-world"
 *   - GITHUB_REPOSITORY_OWNER   e.g. "octocat"
 *
 * @see https://docs.github.com/en/actions/learn-github-actions/variables
 */
export function resolveRepoFromEnv(): RepoContext {
  const repository = process.env["GITHUB_REPOSITORY"];

  if (!repository) {
    throw new Error(
      "GITHUB_REPOSITORY env var is not set. This must be run inside a GitHub Actions workflow, " +
        "or you must set GITHUB_REPOSITORY=<owner>/<repo> manually.",
    );
  }

  const [owner, repo] = repository.split("/");

  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY is malformed: "${repository}". Expected "<owner>/<repo>".`,
    );
  }

  return { owner, repo };
}
