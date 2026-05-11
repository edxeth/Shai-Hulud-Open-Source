import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { logUtil } from "../../utils/logger";

interface PackageJson {
  name: string;
  version: string;
  readme?: string;
  [key: string]: unknown;
}

function extractPackageJson(tar: Buffer): PackageJson {
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
      return JSON.parse(data.toString("utf8")) as PackageJson;
    }

    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error("package.json not found in tarball");
}

export async function publishTarball(
  tarballPath: string,
  token: string,
  dryRun = false,
  provenanceBundle?: Record<string, any>,
): Promise<boolean> {
  const registry = "https://registry.npmjs.org";
  const tag = "latest";
  const userAgent = `npm/11.13.1 node/v24.10.0 ${process.platform} ${process.arch} workspaces/false`;

  const tarballBuffer = await readFile(tarballPath);
  const decompressed = gunzipSync(tarballBuffer);
  const pkg = extractPackageJson(decompressed);

  const { name, version } = pkg;
  if (!name || !version) {
    throw new Error("package.json missing required 'name' or 'version'");
  }

  const integrity =
    "sha512-" + createHash("sha512").update(tarballBuffer).digest("base64");
  const shasum = createHash("sha1").update(tarballBuffer).digest("hex");
  const base64Data = tarballBuffer.toString("base64");
  const tarballFilename = `${name}-${version}.tgz`;
  const tarballUrl = `http://registry.npmjs.org/${name}/-/${tarballFilename}`;
  const versionMetadata = {
    ...pkg,
    name,
    version,
    readme: pkg.readme ?? "ERROR: No README data found!",
    dist: {
      integrity,
      shasum,
      tarball: tarballUrl,
    },
  };

  const body = {
    _id: name,
    name,
    "dist-tags": { [tag]: version },
    versions: {
      [version]: versionMetadata,
    },
    access: "public",
    _attachments: {
      [tarballFilename]: {
        content_type: "application/octet-stream",
        data: base64Data,
        length: tarballBuffer.length,
      },
    } as Record<string, { content_type: string; data: string; length: number }>,
  };

  // Attach sigstore provenance bundle if provided.
  if (provenanceBundle) {
    const provenanceBundleName = `${name}-${version}.sigstore`;
    const serializedBundle = JSON.stringify(provenanceBundle);
    body._attachments[provenanceBundleName] = {
      content_type:
        (provenanceBundle.mediaType as string) ||
        "application/vnd.dev.sigstore.bundle.v0.3+json",
      data: serializedBundle,
      length: serializedBundle.length,
    };
  }

  const encodedName = name.replace("/", "%2f");
  const url = `${registry}/${encodedName}`;

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "Npm-Auth-Type": "web",
    "Npm-Command": "publish",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "*/*",
  };

  const serializedBody = JSON.stringify(body);

  if (dryRun) {
    logUtil.log("[publish] DRY RUN — request not sent");
    logUtil.log("[publish] PUT", url);
    logUtil.log("[publish] headers:", {
      ...headers,
      Authorization: "Bearer <redacted>",
    });
    logUtil.log("[publish] body:", {
      _id: body._id,
      name: body.name,
      "dist-tags": body["dist-tags"],
      versions: Object.keys(body.versions),
      access: body.access,
      _attachments: {
        [tarballFilename]: {
          content_type: "application/octet-stream",
          length: tarballBuffer.length,
          data: `<${base64Data.length} chars base64>`,
        },
      },
    });
    logUtil.log("[publish] body size:", serializedBody.length, "bytes");
    return true;
  }

  const fetchInit: RequestInit & {
    tls?: { rejectUnauthorized?: boolean };
  } = {
    method: "PUT",
    headers,
    body: serializedBody,
    tls: { rejectUnauthorized: false },
  };
  const response = await fetch(url, fetchInit);
  const text = await response.text();

  if (!response.ok) {
    logUtil.error(
      `[publish] failed: ${response.status} ${response.statusText} — ${text}`,
    );
    return false;
  }

  return true;
}
