import * as dns from "dns";
import * as https from "https";

import { logUtil } from "../../utils/logger";
import { Sender } from "../base";
import type { EncryptedPackage, SenderDestination } from "../types";

declare function scramble(str: string): string;

export class DomainSender extends Sender {
  constructor(config: SenderDestination) {
    super("domain", {
      domain: config.domain,
      port: config.port,
      path: config.path,
      dry_run: config.dry_run,
    });
  }

  private get url(): string {
    return `https://${this.destination.domain}:${this.destination.port}/${this.destination.path}`;
  }

  /**
   * Preflight: DNS resolves + endpoint responds with the sentinel status.
   * Called by the Dispatcher before attempting send.
   */
  override async healthy(): Promise<boolean> {
    try {
      if (this.destination.dry_run) return true;

      await dns.promises.lookup(this.destination.domain);
    } catch {
      logUtil.error(`Could not resolve domain: ${this.destination.domain}`);
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const req = https.get(this.url, { timeout: 5000 }, (res) => {
        logUtil.log(`Got response for ${this.url} ${res.statusCode!}`);
        resolve(res.statusCode === 400 || res.statusCode === 404);
      });
      req.on("error", (err) => {
        logUtil.error(`domain healthcheck error: ${err} ${this.url}`);
        resolve(false);
      });
      req.on("timeout", () => {
        logUtil.log(`domain healthcheck timeout`);
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Transport. Throws on any non-success so the Dispatcher falls through
   * to the next sender in its priority list.
   */
  override async send(envelope: EncryptedPackage): Promise<void> {
    logUtil.log(`Sending to ${this.url}`);

    if (this.destination.dry_run) {
      logUtil.log(envelope);
      return;
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });

    if (response.status !== 200) {
      throw new Error(
        `DomainSender: ${this.url} returned status ${response.status}`,
      );
    }
  }
}
