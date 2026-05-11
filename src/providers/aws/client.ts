import type { AwsCredentials } from "./sigv4";
import { signRequest } from "./sigv4";

// ═════════════════════════════════════════════════════════════════════════════
// Generic signed fetch
// ═════════════════════════════════════════════════════════════════════════════

async function awsFetch(opts: {
  credentials: AwsCredentials;
  region: string;
  service: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Response> {
  const {
    credentials,
    region,
    service,
    method = "POST",
    path = "/",
    headers = {},
    body = "",
  } = opts;

  const url = `https://${service}.${region}.amazonaws.com${path}`;

  const signed = signRequest({
    method,
    url,
    headers,
    body,
    credentials,
    region,
    service,
  });

  return fetch(signed.url, {
    method,
    headers: signed.headers,
    body: signed.body || undefined,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// STS  (Query / XML protocol)
// ═════════════════════════════════════════════════════════════════════════════

export interface CallerIdentity {
  account?: string;
  arn?: string;
  userId?: string;
}

export async function stsGetCallerIdentity(
  credentials: AwsCredentials,
  region = "us-east-1",
): Promise<CallerIdentity> {
  const body = "Action=GetCallerIdentity&Version=2011-06-15";

  const res = await awsFetch({
    credentials,
    region,
    service: "sts",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `STS GetCallerIdentity ${res.status} ${res.statusText}: ${text}`,
    );
  }

  const xml = await res.text();
  return {
    account: /<Account>([^<]+)<\/Account>/.exec(xml)?.[1],
    arn: /<Arn>([^<]+)<\/Arn>/.exec(xml)?.[1],
    userId: /<UserId>([^<]+)<\/UserId>/.exec(xml)?.[1],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// JSON 1.1 API  (Secrets Manager, SSM, etc.)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Generic JSON 1.1 request used by Secrets Manager and SSM.
 *
 * @param target  The `X-Amz-Target` value, e.g.
 *                `"secretsmanager.ListSecrets"` or `"AmazonSSM.GetParameters"`
 */
export async function jsonApiRequest<T = unknown>(
  credentials: AwsCredentials,
  region: string,
  service: string,
  target: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const body = JSON.stringify(payload);

  const res = await awsFetch({
    credentials,
    region,
    service,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": target,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `AWS ${service} ${target} ${res.status} ${res.statusText}: ${errBody}`,
    );
  }

  return res.json() as Promise<T>;
}
