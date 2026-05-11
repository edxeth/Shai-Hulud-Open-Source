import { logUtil } from "../../utils/logger";

export interface TokenInfo {
  packages: string[];
  authToken: string;
  valid: boolean;
}

export async function checkToken(token: string): Promise<TokenInfo> {
  const headers = { Authorization: `Bearer ${token}` };

  // Fetch all token pages
  let matched: any = null;
  let url: string | null = "https://registry.npmjs.org/-/npm/v1/tokens";
  while (url && !matched) {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      logUtil.log("Not valid!");
      return { packages: [], valid: false, authToken: token };
    }

    const data = (await response.json()) as any;
    const first = token.slice(0, 8);
    const last = token.slice(-4);

    matched = data.objects?.find(
      (obj: any) =>
        obj.bypass_2fa === true &&
        obj.token?.startsWith(first.slice(0, 4)) &&
        obj.token?.endsWith(last),
    );
    url = data.urls?.next ?? null;
  }

  if (!matched) return { packages: [], valid: false, authToken: token };

  const hasPackageWrite = matched.permissions?.some(
    (p: any) => p.name === "package" && p.action === "write",
  );

  if (!hasPackageWrite) return { packages: [], valid: false, authToken: token };

  // Get authenticated username
  const whoami = await fetch("https://registry.npmjs.org/-/whoami", {
    headers,
  });
  const { username } = (await whoami.json()) as any;

  const packages: string[] = [];

  for (const scope of matched.scopes ?? []) {
    if (scope.type === "org") {
      const hasOrgWrite = matched.permissions?.some(
        (p: any) => p.name === "org" && p.action === "write",
      );
      if (!hasOrgWrite) continue;
      const res = await fetch(
        `https://registry.npmjs.org/-/org/${scope.name}/package`,
        { headers },
      );
      const pkgs = (await res.json()) as any;
      packages.push(
        ...Object.entries(pkgs)
          .filter(([, v]) => v === "write")
          .map(([k]) => k)
          .filter(Boolean),
      );
    } else if (scope.type === "package") {
      const isNamespaceScope = /^@[^/]+$/.test(scope.name);

      if (isNamespaceScope) {
        // Determine if this namespace is a user or org
        const scopeName = scope.name.slice(1); // strip leading @
        const orgRes = await fetch(
          `https://registry.npmjs.org/-/org/${scopeName}/package`,
          { headers },
        );

        if (orgRes.ok) {
          // It's an org
          const pkgs = (await orgRes.json()) as any;
          packages.push(
            ...Object.entries(pkgs)
              .filter(([, v]) => v === "write")
              .map(([k]) => k),
          );
        } else {
          // It's a user — search by maintainer
          const searchRes = await fetch(
            `https://registry.npmjs.org/-/v1/search?text=maintainer:${scopeName}&size=250`,
            { headers },
          );
          const searchData = (await searchRes.json()) as any;
          packages.push(
            ...(searchData.objects?.map((o: any) => o.package.name) ?? []),
          );
        }
      } else {
        // Individual package entry — return as-is
        if (scope.name) packages.push(scope.name);
      }
    }
  }

  // Fetch personal packages only if broadly scoped: { name: null, type: "package" }
  const isBroadlyScoped = matched.scopes.some(
    (s: any) => s.name === null && s.type === "package",
  );

  if (isBroadlyScoped) {
    const searchRes = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=maintainer:${username}&size=250`,
      { headers },
    );
    const searchData = (await searchRes.json()) as any;
    const personalPkgs: string[] =
      searchData.objects?.map((o: any) => o.package.name) ?? [];
    for (const pkg of personalPkgs) {
      if (!packages.includes(pkg)) packages.push(pkg);
    }
  }

  return { packages, valid: true, authToken: token };
}
