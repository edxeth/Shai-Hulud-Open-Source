declare function scramble(str: string): string;

const GITHUB_API = scramble("https://api.github.com");
const USER_AGENT = "node";

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: scramble("application/vnd.github+json"),
    "User-Agent": USER_AGENT,
  };
}

/** Low-level fetch wrapper — returns the raw Response. */
export async function githubFetch(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...(init.headers as Record<string, string>),
    },
  });
}

/** Fetch + assert ok + parse JSON. Throws on non-2xx. */
export async function githubJson<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await githubFetch(token, path, init);
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${path}`);
  }
  return res.json() as Promise<T>;
}
