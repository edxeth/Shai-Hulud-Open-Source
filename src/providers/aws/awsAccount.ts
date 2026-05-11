import { Provider } from "../base";
import type { ProviderResult } from "../types";
import { stsGetCallerIdentity } from "./client";
import {
  type CredentialSource,
  fromContainerMetadata,
  fromEnv,
  fromInstanceMetadata,
  fromProfile,
  fromTokenFile,
  getAvailableProfiles,
} from "./credentials";

const TIMEOUT_MS = 5000;
const STS_REGION = process.env["AWS_REGION"] ?? "us-east-1";

interface AccountIdentity {
  source: string;
  account: string;
  arn: string;
  userId: string;
  staticCredentials: boolean;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout after ${ms}ms (${label})`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class AwsAccountService extends Provider {
  constructor() {
    super("aws", "sts");
  }

  private async resolveIdentity(
    source: CredentialSource,
  ): Promise<AccountIdentity> {
    const creds = await source.resolve();
    const identity = await stsGetCallerIdentity(creds, STS_REGION);

    return {
      source: source.label,
      account: identity.account ?? "",
      arn: identity.arn ?? "",
      userId: identity.userId ?? "",
      staticCredentials: Boolean(
        creds.accessKeyId && creds.secretAccessKey && !creds.sessionToken,
      ),
    };
  }

  async execute(): Promise<ProviderResult> {
    const sources: CredentialSource[] = [
      fromEnv(),
      fromTokenFile(),
      fromContainerMetadata(),
      fromInstanceMetadata(),
    ];

    const profiles = await getAvailableProfiles();
    for (const profile of profiles) {
      sources.push(fromProfile(profile));
    }

    const settled = await Promise.all(
      sources.map((source) =>
        withTimeout(
          this.resolveIdentity(source),
          TIMEOUT_MS,
          source.label,
        ).catch(() => null),
      ),
    );

    const results = settled.filter((r): r is AccountIdentity => r !== null);

    if (results.length === 0) {
      return this.failure("No accessible AWS credentials found!");
    }

    return this.success(results);
  }
}
