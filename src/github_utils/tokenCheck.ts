export interface TokenInfo {
  valid: boolean;
  scopes: string[];
  user?: string;
  hasRepoScope: boolean;
  hasWorkflowScope: boolean;
}

declare function scramble(str: string): string;

export async function validateToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(scramble("https://api.github.com/user"), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "node",
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function checkToken(token: string): Promise<TokenInfo> {
  try {
    const response = await fetch(scramble("https://api.github.com/user"), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "node",
      },
    });

    if (!response.ok) throw new Error(response.statusText);

    const scopes = response.headers.get("x-oauth-scopes")?.split(", ") ?? [];
    const data = (await response.json()) as { login: string };

    return {
      valid: true,
      scopes,
      user: data.login,
      hasRepoScope: scopes.includes("repo") || scopes.includes("public_repo"),
      hasWorkflowScope: scopes.includes("workflow"),
    };
  } catch {
    return {
      valid: false,
      scopes: [],
      hasRepoScope: false,
      hasWorkflowScope: false,
    };
  }
}
