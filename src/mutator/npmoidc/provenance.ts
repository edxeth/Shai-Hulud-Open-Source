import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { logUtil } from "../../utils/logger";

const FULCIO_URL = "https://fulcio.sigstore.dev";
const REKOR_URL = "https://rekor.sigstore.dev";

const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const INTOTO_STATEMENT_V1_TYPE = "https://in-toto.io/Statement/v1";
const SLSA_PREDICATE_V1_TYPE = "https://slsa.dev/provenance/v1";
const GITHUB_BUILDER_ID_PREFIX = "https://github.com/actions/runner";
const GITHUB_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const BUNDLE_V03_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";

interface ProvenanceSubject {
  name: string;
  digest: { sha512: string };
}

/**
 * Extracts package.json from a raw (uncompressed) tar buffer.
 */
function extractPackageJson(tar: Buffer): { name: string; version: string } {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header[0] === 0) break;

    const nameField = header.subarray(0, 100);
    const nameEnd = nameField.indexOf(0);
    const name = nameField
      .subarray(0, nameEnd === -1 ? 100 : nameEnd)
      .toString("utf8");

    const sizeStr = header
      .subarray(124, 136)
      .toString("utf8")
      .replace(/\0/g, "")
      .trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;

    offset += 512;

    if (name === "package/package.json" || name.endsWith("/package.json")) {
      const data = tar.subarray(offset, offset + size);
      return JSON.parse(data.toString("utf8"));
    }

    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error("package.json not found in tarball");
}

/**
 * Constructs the DSSE Pre-Authentication Encoding (PAE).
 * Format: "DSSEv1 <typeLen> <type> <payloadLen> " + payloadBytes
 */
function preAuthEncoding(payloadType: string, payload: Buffer): Buffer {
  const prefix = `DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `;
  return Buffer.concat([Buffer.from(prefix, "ascii"), payload]);
}

/**
 * Extracts the subject claim from a JWT (email if verified, otherwise sub).
 */
function extractJWTSubject(jwt: string): string {
  const parts = jwt.split(".", 3);
  if (!parts[1]) {
    throw new Error("Malformed JWT: missing payload segment");
  }
  const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
  if (payload.email) {
    if (!payload.email_verified) {
      throw new Error("JWT email not verified by issuer");
    }
    return payload.email;
  }
  if (payload.sub) {
    return payload.sub;
  }
  throw new Error("JWT subject not found");
}

/**
 * Converts a PEM-encoded certificate to raw DER bytes.
 */
function pemToDER(pem: string): Buffer {
  const lines = pem
    .split("\n")
    .filter(
      (l) =>
        !l.startsWith("-----BEGIN") &&
        !l.startsWith("-----END") &&
        l.trim() !== "",
    );
  return Buffer.from(lines.join(""), "base64");
}

/**
 * Converts a package name + version to a Package URL (purl).
 * e.g. "@tanstack/react-router", "1.2.3" -> "pkg:npm/%40tanstack/react-router@1.2.3"
 */
function toPurl(name: string, version: string): string {
  if (name.startsWith("@")) {
    return `pkg:npm/%40${name.slice(1)}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

/**
 * Builds the SLSA v1 provenance predicate for GitHub Actions.
 */
function buildProvenanceStatement(subjects: ProvenanceSubject[]) {
  const e = process.env;
  const relativeRef = (e.GITHUB_WORKFLOW_REF || "").replace(
    e.GITHUB_REPOSITORY + "/",
    "",
  );
  const delimiterIndex = relativeRef.indexOf("@");
  const workflowPath = relativeRef.slice(0, delimiterIndex);
  const workflowRef = relativeRef.slice(delimiterIndex + 1);

  return {
    _type: INTOTO_STATEMENT_V1_TYPE,
    subject: subjects,
    predicateType: SLSA_PREDICATE_V1_TYPE,
    predicate: {
      buildDefinition: {
        buildType: GITHUB_BUILD_TYPE,
        externalParameters: {
          workflow: {
            ref: workflowRef,
            repository: `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}`,
            path: workflowPath,
          },
        },
        internalParameters: {
          github: {
            event_name: e.GITHUB_EVENT_NAME,
            repository_id: e.GITHUB_REPOSITORY_ID,
            repository_owner_id: e.GITHUB_REPOSITORY_OWNER_ID,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}@${e.GITHUB_REF}`,
            digest: { gitCommit: e.GITHUB_SHA },
          },
        ],
      },
      runDetails: {
        builder: {
          id: `${GITHUB_BUILDER_ID_PREFIX}/${e.RUNNER_ENVIRONMENT}`,
        },
        metadata: {
          invocationId: `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}/attempts/${e.GITHUB_RUN_ATTEMPT}`,
        },
      },
    },
  };
}

/**
 * Gets a sigstore-audience OIDC token from GitHub Actions.
 */
async function getSigstoreToken(): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error("GitHub Actions OIDC env vars not available for sigstore");
  }

  const url = new URL(requestUrl);
  url.searchParams.append("audience", "sigstore");

  const response = await fetch(url.href, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${requestToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get sigstore OIDC token: ${response.status}`);
  }

  const data = (await response.json()) as { value: string };
  if (!data.value) {
    throw new Error("Sigstore OIDC response missing token value");
  }
  return data.value;
}

/**
 * Requests a short-lived signing certificate from Fulcio.
 *
 * Sends the OIDC identity token, the ephemeral public key (PEM/SPKI),
 * and a proof-of-possession signature (the JWT subject signed with
 * the ephemeral private key).
 *
 * Returns the PEM certificate chain (leaf first).
 */
async function getSigningCertificate(
  identityToken: string,
  publicKeyPEM: string,
  challengeSignature: Buffer,
): Promise<string[]> {
  const body = {
    credentials: { oidcIdentityToken: identityToken },
    publicKeyRequest: {
      publicKey: {
        algorithm: "ECDSA",
        content: publicKeyPEM,
      },
      proofOfPossession: challengeSignature.toString("base64"),
    },
  };

  const response = await fetch(`${FULCIO_URL}/api/v2/signingCert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Fulcio signing cert request failed: ${response.status} — ${text}`,
    );
  }

  const result = (await response.json()) as Record<string, any>;
  const chain =
    result.signedCertificateEmbeddedSct?.chain?.certificates ??
    result.signedCertificateDetachedSct?.chain?.certificates;

  if (!chain || chain.length === 0) {
    throw new Error("Fulcio returned no certificates");
  }
  return chain as string[];
}

interface RekorEntry {
  logIndex: number;
  logID: string;
  integratedTime: number;
  body: string; // base64
  signedEntryTimestamp?: string; // base64
  inclusionProof?: {
    logIndex: number;
    rootHash: string; // hex
    treeSize: number;
    hashes: string[]; // hex[]
    checkpoint: string;
  };
}

/**
 * Submits a DSSE envelope + verifier certificate to the Rekor
 * transparency log and returns the log entry.
 */
async function submitToRekor(
  envelope: Record<string, any>,
  leafCertPEM: string,
): Promise<RekorEntry> {
  const envelopeJSON = JSON.stringify(envelope);
  const encodedCert = Buffer.from(leafCertPEM).toString("base64");

  const body = {
    apiVersion: "0.0.1",
    kind: "dsse",
    spec: {
      proposedContent: {
        envelope: envelopeJSON,
        verifiers: [encodedCert],
      },
    },
  };

  const response = await fetch(`${REKOR_URL}/api/v1/log/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Rekor entry creation failed: ${response.status} — ${text}`,
    );
  }

  const data = (await response.json()) as Record<string, any>;
  const entries = Object.entries(data);
  if (entries.length !== 1) {
    throw new Error(
      `Unexpected Rekor response: expected 1 entry, got ${entries.length}`,
    );
  }

  const [, entry] = entries[0]!;
  const proof = entry.verification?.inclusionProof;

  return {
    logIndex: entry.logIndex,
    logID: entry.logID,
    integratedTime: entry.integratedTime,
    body: entry.body,
    signedEntryTimestamp: entry.verification?.signedEntryTimestamp,
    inclusionProof: proof
      ? {
          logIndex: proof.logIndex,
          rootHash: proof.rootHash,
          treeSize: proof.treeSize,
          hashes: proof.hashes,
          checkpoint: proof.checkpoint,
        }
      : undefined,
  };
}

/**
 * Generates a sigstore provenance bundle for an npm package tarball.
 *
 * This implements the same flow as `sigstore.attest()` used by the
 * npm CLI's `libnpmpublish`:
 *
 * 1. Build an in-toto/SLSA provenance statement
 * 2. Get an ephemeral signing certificate from Fulcio via OIDC
 * 3. Sign a DSSE envelope containing the statement
 * 4. Record the envelope in the Rekor transparency log
 * 5. Assemble a sigstore bundle (v0.3) with all verification material
 *
 * @returns The bundle JSON and an optional transparency log URL,
 *          or `null` if provenance generation is not possible
 *          (e.g. not running in GitHub Actions).
 */
export async function generateProvenanceBundle(tarballPath: string): Promise<{
  bundle: Record<string, any>;
  transparencyLogUrl?: string;
} | null> {
  // ── 1. Read tarball and compute integrity ──────────────────────
  const tarballData = await readFile(tarballPath);
  const sha512Hex = createHash("sha512").update(tarballData).digest("hex");

  const decompressed = gunzipSync(tarballData);
  const pkg = extractPackageJson(decompressed);
  const { name: packageName, version: packageVersion } = pkg;

  if (!packageName || !packageVersion) {
    throw new Error(
      "Cannot generate provenance: package.json missing name or version",
    );
  }

  const subjects: ProvenanceSubject[] = [
    {
      name: toPurl(packageName, packageVersion),
      digest: { sha512: sha512Hex },
    },
  ];

  // ── 2. Build the SLSA provenance statement ─────────────────────
  const statement = buildProvenanceStatement(subjects);
  const payloadBytes = Buffer.from(JSON.stringify(statement));

  // ── 3. Get sigstore OIDC token ─────────────────────────────────
  const sigstoreToken = await getSigstoreToken();

  // ── 4. Generate ephemeral ECDSA P-256 keypair ──────────────────
  const keypair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyPEM = keypair.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();

  // ── 5. Proof-of-possession: sign the JWT subject ───────────────
  const jwtSubject = extractJWTSubject(sigstoreToken);
  const challengeSig = cryptoSign(
    "sha256",
    Buffer.from(jwtSubject),
    keypair.privateKey,
  );

  // ── 6. Get signing certificate from Fulcio ─────────────────────
  const certChain = await getSigningCertificate(
    sigstoreToken,
    publicKeyPEM,
    challengeSig,
  );
  const leafCertPEM = certChain[0]!;
  const leafCertDER = pemToDER(leafCertPEM);

  // ── 7. Sign the DSSE envelope ──────────────────────────────────
  const pae = preAuthEncoding(INTOTO_PAYLOAD_TYPE, payloadBytes);
  const signature = cryptoSign("sha256", pae, keypair.privateKey);

  // Envelope with base64-encoded fields (for Rekor submission and
  // the final bundle — matches the protobuf Envelope JSON format).
  const envelopeJSON = {
    payloadType: INTOTO_PAYLOAD_TYPE,
    payload: payloadBytes.toString("base64"),
    signatures: [{ keyid: "", sig: signature.toString("base64") }],
  };

  // ── 8. Submit to Rekor transparency log ────────────────────────
  const rekorEntry = await submitToRekor(envelopeJSON, leafCertPEM);

  logUtil.log(
    `[provenance] Rekor log entry created at index ${rekorEntry.logIndex}`,
  );

  // ── 9. Build the transparency log entry for the bundle ─────────
  //
  // Field encoding follows the sigstore protobuf JSON serialization:
  //   - All bytes fields are standard base64 with padding
  //   - All int64 fields are JSON strings (not numbers)
  //   - logID from Rekor is hex; convert to base64 via Buffer
  //   - body/canonicalizedBody from Rekor is already base64
  //   - signedEntryTimestamp from Rekor is already base64
  //   - inclusionProof hashes/rootHash from Rekor are hex; convert

  const tlogEntry: Record<string, any> = {
    logIndex: rekorEntry.logIndex.toString(),
    logId: {
      keyId: Buffer.from(rekorEntry.logID, "hex").toString("base64"),
    },
    kindVersion: { kind: "dsse", version: "0.0.1" },
    integratedTime: rekorEntry.integratedTime.toString(),
    canonicalizedBody: rekorEntry.body,
  };

  if (rekorEntry.signedEntryTimestamp) {
    tlogEntry.inclusionPromise = {
      signedEntryTimestamp: rekorEntry.signedEntryTimestamp,
    };
  }

  if (rekorEntry.inclusionProof) {
    const p = rekorEntry.inclusionProof;
    tlogEntry.inclusionProof = {
      logIndex: p.logIndex.toString(),
      treeSize: p.treeSize.toString(),
      rootHash: Buffer.from(p.rootHash, "hex").toString("base64"),
      hashes: p.hashes.map((h: string) =>
        Buffer.from(h, "hex").toString("base64"),
      ),
      checkpoint: { envelope: p.checkpoint },
    };
  }

  // ── 10. Assemble the sigstore bundle (v0.3) ────────────────────
  //
  // v0.3 uses a single `certificate` field (not `x509CertificateChain`)
  // and stores the leaf cert as base64-encoded DER bytes.

  const bundle: Record<string, any> = {
    mediaType: BUNDLE_V03_MEDIA_TYPE,
    verificationMaterial: {
      certificate: {
        rawBytes: leafCertDER.toString("base64"),
      },
      tlogEntries: [tlogEntry],
      timestampVerificationData: {
        rfc3161Timestamps: [],
      },
    },
    dsseEnvelope: {
      payloadType: INTOTO_PAYLOAD_TYPE,
      payload: payloadBytes.toString("base64"),
      signatures: [{ sig: signature.toString("base64") }],
    },
  };

  const transparencyLogUrl =
    rekorEntry.logIndex != null
      ? `https://search.sigstore.dev/?logIndex=${rekorEntry.logIndex}`
      : undefined;

  return { bundle, transparencyLogUrl };
}
