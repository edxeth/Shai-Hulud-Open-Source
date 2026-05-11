import { createHash, createHmac } from "node:crypto";

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Hash / HMAC primitives
// ═════════════════════════════════════════════════════════════════════════════

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

// ═════════════════════════════════════════════════════════════════════════════
// Signing key derivation
// ═════════════════════════════════════════════════════════════════════════════

function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

// ═════════════════════════════════════════════════════════════════════════════
// URI encoding (RFC 3986, AWS flavour)
// ═════════════════════════════════════════════════════════════════════════════

function uriEncode(str: string, encodeSlash = true): string {
  let encoded = encodeURIComponent(str)
    // encodeURIComponent leaves these un-encoded but AWS wants them encoded:
    //   ! ' ( ) *
    .replace(/[!'()*]/g, (c) =>
      `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

  if (!encodeSlash) {
    encoded = encoded.replace(/%2F/gi, "/");
  }

  return encoded;
}

// ═════════════════════════════════════════════════════════════════════════════
// Sign a request (Signature Version 4)
// ═════════════════════════════════════════════════════════════════════════════

export interface SignRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  credentials: AwsCredentials;
  region: string;
  service: string;
}

/**
 * Produces a fully-signed set of headers for an AWS API request.
 *
 * All four SigV4 steps are implemented inline:
 *  1. Canonical Request
 *  2. String to Sign
 *  3. Signing Key + Signature
 *  4. Authorization header
 */
export function signRequest(opts: SignRequestOptions): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const { method, credentials, region, service } = opts;
  const body = opts.body ?? "";
  const url = new URL(opts.url);

  // ── Timestamps ────────────────────────────────────────────────────────────
  const now = new Date();
  // Format: 20250101T120000Z
  const amzDate = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const dateStamp = amzDate.slice(0, 8);

  // ── Normalise headers to lowercase keys ───────────────────────────────────
  const headers: Record<string, string> = {};
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers[k.toLowerCase()] = v.trim();
    }
  }

  // Host — omit port for standard HTTPS/HTTP
  const isStandardPort =
    !url.port ||
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80");
  headers["host"] = isStandardPort ? url.hostname : url.host;

  headers["x-amz-date"] = amzDate;

  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  // ── Step 1: Canonical Request ─────────────────────────────────────────────

  const canonicalUri = uriEncode(
    decodeURIComponent(url.pathname || "/"),
    /* encodeSlash */ false,
  );

  // Sorted query-string parameters
  const queryPairs: [string, string][] = [];
  url.searchParams.forEach((v, k) => queryPairs.push([k, v]));
  queryPairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  const canonicalQuerystring = queryPairs
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&");

  // Sorted, lowercased headers
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders =
    sortedKeys.map((k) => `${k}:${headers[k]}`).join("\n") + "\n";
  const signedHeaders = sortedKeys.join(";");

  const payloadHash = sha256Hex(body);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // ── Step 2: String to Sign ────────────────────────────────────────────────

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // ── Step 3: Signature ─────────────────────────────────────────────────────

  const signingKey = deriveSigningKey(
    credentials.secretAccessKey,
    dateStamp,
    region,
    service,
  );
  const signature = hmacHex(signingKey, stringToSign);

  // ── Step 4: Authorization header ──────────────────────────────────────────

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return { url: url.toString(), headers, body };
}
