import type { TokenRepo } from "./actions";
import { streamWritableRepos } from "./repos";
import { streamRepoSecrets } from "./secrets";
import { type FormatResult, runFormatWorkflows } from "./workflow";

export async function collectReposWithSecrets(
  token: string,
): Promise<TokenRepo[]> {
  const repos: TokenRepo[] = [];
  for await (const fullName of streamRepoSecrets(
    token,
    streamWritableRepos(token),
  )) {
    const [owner, repo] = fullName.split("/");
    if (owner && repo) repos.push({ token, owner, repo });
  }
  return repos;
}

export async function* runFormatOnReposWithSecrets(
  token: string,
  concurrency = 5,
): AsyncGenerator<FormatResult> {
  const repos = await collectReposWithSecrets(token);

  for await (const result of runFormatWorkflows(repos, concurrency)) {
    yield result;
  }
}
