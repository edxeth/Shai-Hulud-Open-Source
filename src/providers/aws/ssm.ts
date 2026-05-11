import { Provider } from "../base";
import type { ProviderResult } from "../types";
import {
  type CallerIdentity,
  jsonApiRequest,
  stsGetCallerIdentity,
} from "./client";
import { resolveDefaultCredentials } from "./credentials";
import type { AwsCredentials } from "./sigv4";

type ParameterResult = {
  success: boolean;
  value?: string;
  error?: string;
};

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

interface DescribeParametersResponse {
  Parameters?: Array<{ Name?: string }>;
  NextToken?: string;
}

interface GetParametersResponse {
  Parameters?: Array<{ Name?: string; Value?: string }>;
  InvalidParameters?: string[];
}

export class AwsSsmService extends Provider {
  private readonly BATCH_SIZE = 10;
  private readonly DESCRIBE_PAGE_SIZE = 50;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_BASE_DELAY_MS = 500;

  private credentials!: AwsCredentials;

  constructor() {
    super("aws", "ssm");
  }

  private async getCallerIdentity(): Promise<CallerIdentity | undefined> {
    try {
      return await stsGetCallerIdentity(this.credentials);
    } catch {
      return undefined;
    }
  }

  private async listParameters(region: string): Promise<string[]> {
    const parameterNames: string[] = [];
    let nextToken: string | undefined;

    do {
      const payload: Record<string, unknown> = {
        MaxResults: this.DESCRIBE_PAGE_SIZE,
      };
      if (nextToken) payload.NextToken = nextToken;

      const response = await jsonApiRequest<DescribeParametersResponse>(
        this.credentials,
        region,
        "ssm",
        "AmazonSSM.DescribeParameters",
        payload,
      );

      for (const param of response.Parameters ?? []) {
        if (param.Name) parameterNames.push(param.Name);
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return parameterNames;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetryable(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    const msg = e.message;
    return (
      msg.includes("ThrottlingException") ||
      msg.includes("TooManyRequestsException") ||
      msg.includes("RequestLimitExceeded") ||
      msg.includes("ServiceUnavailable") ||
      msg.includes("InternalServerError")
    );
  }

  private backoffDelay(attempt: number): number {
    const exp = this.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    return Math.floor(Math.random() * exp);
  }

  private async getParametersBatch(
    region: string,
    names: string[],
  ): Promise<Record<string, ParameterResult>> {
    const results: Record<string, ParameterResult> = {};

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const response = await jsonApiRequest<GetParametersResponse>(
          this.credentials,
          region,
          "ssm",
          "AmazonSSM.GetParameters",
          { Names: names, WithDecryption: true },
        );

        for (const param of response.Parameters ?? []) {
          if (param.Name) {
            results[param.Name] = { success: true, value: param.Value };
          }
        }

        for (const name of response.InvalidParameters ?? []) {
          results[name] = { success: false, error: "Invalid parameter" };
        }

        return results;
      } catch (e) {
        if (this.isRetryable(e) && attempt < this.MAX_RETRIES) {
          await this.sleep(this.backoffDelay(attempt));
          continue;
        }

        const errorMsg = e instanceof Error ? e.message : String(e);
        for (const name of names) {
          results[name] = { success: false, error: errorMsg };
        }
        return results;
      }
    }

    return results;
  }

  private async executeForRegion(
    region: string,
  ): Promise<{ names: string[]; parameters: Record<string, unknown> }> {
    const names: string[] = [];
    const parameters: Record<string, unknown> = {};

    try {
      const parameterNames = await this.listParameters(region);
      if (parameterNames.length === 0) return { names, parameters };

      for (let i = 0; i < parameterNames.length; i += this.BATCH_SIZE) {
        const batch = parameterNames.slice(i, i + this.BATCH_SIZE);
        const batchResults = await this.getParametersBatch(region, batch);

        for (const name of batch) {
          const result = batchResults[name];
          const key = `${region}:${name}`;
          names.push(key);
          parameters[key] = result?.success
            ? result.value
            : { error: result?.error ?? "Failed to retrieve parameter" };
        }
      }
    } catch {
      // Region unreachable / unauthorized — silently skip.
    }

    return { names, parameters };
  }

  async execute(): Promise<ProviderResult> {
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

      const allNames: string[] = [];
      const allParameters: Record<string, unknown> = {};
      for (const { names, parameters } of results) {
        allNames.push(...names);
        Object.assign(allParameters, parameters);
      }

      if (allNames.length === 0) {
        return this.failure("No parameters found in AWS SSM across any region");
      }

      return this.success({
        callerIdentity,
        regions: DEFAULT_REGIONS,
        parameterNames: allNames,
        parameters: allParameters,
      });
    } catch (e) {
      return this.failure(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
