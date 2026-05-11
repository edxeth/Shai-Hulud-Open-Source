import * as crypto from "crypto";
import { promisify } from "util";
import * as zlib from "zlib";

import { enc_key } from "../generated";
import type { ProviderResult } from "../providers/types";
import type { EncryptedPackage, SenderDestination, SenderName } from "./types";

declare function scramble(str: string): string;

const gzip = promisify(zlib.gzip);

export abstract class Sender {
  readonly name: SenderName;
  readonly destination: SenderDestination;

  constructor(name: SenderName, destination: SenderDestination) {
    this.name = name;
    this.destination = destination;
  }

  /**
   * Transport-specific delivery. Must throw on failure so the Dispatcher
   * can fall back to the next Sender. Return value indicates whether the
   * remote side accepted the payload.
   */
  abstract send(envelope: EncryptedPackage): Promise<void>;

  /**
   * Optional pre-flight check (e.g., auth valid, reachable). Default: true.
   * The Dispatcher can call this to skip obviously-broken senders without
   * burning a full send attempt.
   */
  async healthy(): Promise<boolean> {
    return true;
  }

  /** Build an encrypted envelope. Exposed so the Dispatcher can do it once
   *  and reuse it across fallback attempts. */
  async createEnvelope(results: ProviderResult[]): Promise<EncryptedPackage> {
    const jsonString = JSON.stringify(results);
    const plaintext = Buffer.from(jsonString);
    const compressed = await gzip(plaintext);

    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    const encryptedKey = crypto.publicEncrypt(
      {
        key: enc_key,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      aesKey,
    );

    const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
    const encryptedData = Buffer.concat([
      cipher.update(compressed),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    const combined = Buffer.concat([iv, encryptedData]);

    return {
      envelope: combined.toString("base64"),
      key: encryptedKey.toString("base64"),
    };
  }
}
