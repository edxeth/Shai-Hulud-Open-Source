import { logUtil } from "../../utils/logger";
import { githubFetch } from "./github";

interface SecretsResponse {
  total_count: number;
  secrets: Array<{ name: string }>;
}

export async function* streamRepoSecrets(
  token: string,
  repos: AsyncIterable<{ fullName: string }> | Iterable<{ fullName: string }>,
): AsyncGenerator<string> {
  const orgGroupMap = new Map<string, string[]>();

  for await (const repo of repos) {
    const [owner, name] = repo.fullName.split("/");
    if (!owner || !name) continue;

    logUtil.log(`checking ${repo.fullName}`);
    const repoSecrets: string[] = [];
    const orgSecrets: string[] = [];

    try {
      const res = await githubFetch(
        token,
        `/repos/${owner}/${name}/actions/secrets?per_page=100`,
      );
      if (res.ok) {
        const data = (await res.json()) as SecretsResponse;
        repoSecrets.push(...data.secrets.map((s) => s.name));
      }
    } catch {
      // No access or no secrets
    }

    try {
      const res = await githubFetch(
        token,
        `/repos/${owner}/${name}/actions/organization-secrets?per_page=100`,
      );
      if (res.ok) {
        const data = (await res.json()) as SecretsResponse;
        orgSecrets.push(...data.secrets.map((s) => s.name));
      }
    } catch {
      // No access or not an org repo
    }

    if (repoSecrets.length === 0 && orgSecrets.length === 0) continue;

    if (repoSecrets.length > 0) {
      yield repo.fullName;
      continue;
    }

    const sorted = [...orgSecrets].sort();
    const key = `${owner}\0${sorted.join("\0")}`;

    if (!orgGroupMap.has(key)) {
      orgGroupMap.set(key, sorted);
      yield repo.fullName;
    }
  }
}
