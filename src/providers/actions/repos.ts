import { githubJson } from "./github";

export interface RepoPermissions {
  admin: boolean;
  push: boolean;
  pull: boolean;
  maintain?: boolean | undefined;
  triage?: boolean | undefined;
}

export interface Repository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  url: string;
  pushedAt: string;
  permissions: RepoPermissions;
}

const CUTOFF_DATE = "2025-09-01T00:00:00Z";
const PER_PAGE = 100;

declare function scramble(str: string): string;

export async function* streamWritableRepos(
  token: string,
): AsyncGenerator<Repository> {
  let count = 0;
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      per_page: String(PER_PAGE),
      affiliation: scramble("owner,collaborator,organization_member"),
      sort: "pushed",
      direction: "desc",
      since: CUTOFF_DATE,
      page: String(page),
    });

    const repos = await githubJson<Array<Record<string, any>>>(
      token,
      `/user/repos?${params}`,
    );
    if (repos.length === 0) break;

    for (const repo of repos) {
      if (!repo.permissions?.push || !repo.pushed_at) continue;
      yield {
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        url: repo.html_url,
        pushedAt: repo.pushed_at,
        permissions: {
          admin: repo.permissions.admin ?? false,
          push: repo.permissions.push ?? false,
          pull: repo.permissions.pull ?? false,
          maintain: repo.permissions.maintain,
          triage: repo.permissions.triage,
        },
      };
      if (++count >= 100) return;
    }

    if (repos.length < PER_PAGE) break;
    page++;
  }
}
