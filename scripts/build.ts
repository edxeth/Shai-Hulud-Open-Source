import { promises as fs } from "fs";
import * as path from "path";

import { transformEnvAccess } from "./env-scramble";
import {
  generateBuildPassphrase,
  rewriteRuntimeDecoder,
  RUNTIME_DECODER_PATH,
  transformSource,
} from "./scramble-shared";
import { stripLogCalls } from "./strip-logs";

(globalThis as any).scramble = (s: string) => s;

const { StringScrambler } = await import("../src/utils/stringtool");

const PASSPHRASE = generateBuildPassphrase();
console.log(`[BUILD] Generated build passphrase (${PASSPHRASE.length} chars)`);

const scrambler = new StringScrambler(PASSPHRASE);

// Read isSilent from the source of truth — logger.ts itself.
const loggerSource = await fs.readFile("src/utils/logger.ts", "utf-8");
const isSilent = /const\s+isSilent\s*=\s*true/.test(loggerSource);
console.log(`[BUILD] isSilent = ${isSilent}`);

async function transformFile(filePath: string): Promise<string> {
  const code = await fs.readFile(filePath, "utf-8");

  console.log(`[TRANSFORM] Processing: ${filePath}`);

  // 1. Rewrite process.env.XYZ -> process.env[scramble("XYZ")]
  const { code: envRewritten } = transformEnvAccess(
    code,
    "[TRANSFORM]",
    filePath,
  );

  // 2. Scramble transform (encodes all scramble("...") calls)
  const { code: scrambled } = transformSource(
    envRewritten,
    scrambler,
    "[TRANSFORM]",
    filePath,
  );

  // 3. Strip logUtil calls (only when isSilent is true)
  if (isSilent) {
    const { code: stripped } = stripLogCalls(
      scrambled,
      "[TRANSFORM]",
      filePath,
    );
    return stripped;
  }

  return scrambled;
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDir(fullPath)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function build() {
  console.log("[BUILD] Setting up temp directory...");

  const tempDir = "./.bun-temp";
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  console.log("[BUILD] Copying and transforming source files...");

  const files = await walkDir("./src");
  console.log(`[BUILD] Processing ${files.length} TypeScript files`);

  for (const file of files) {
    const transformed = await transformFile(file);
    const tempFile = path.join(tempDir, path.relative("./src", file));
    await fs.mkdir(path.dirname(tempFile), { recursive: true });
    await fs.writeFile(tempFile, transformed, "utf-8");
  }

  const tempDecoderPath = path.join(
    tempDir,
    path.relative("./src", path.resolve(RUNTIME_DECODER_PATH)),
  );
  const rewrittenDecoder = await rewriteRuntimeDecoder(
    RUNTIME_DECODER_PATH,
    PASSPHRASE,
  );
  await fs.mkdir(path.dirname(tempDecoderPath), { recursive: true });
  await fs.writeFile(tempDecoderPath, rewrittenDecoder, "utf-8");
  console.log(
    `[BUILD] Injected build passphrase into ${path.relative(tempDir, tempDecoderPath)}`,
  );

  const indexPath = path.join(tempDir, "index.ts");

  const indexCode = await fs.readFile(indexPath, "utf-8");
  await fs.writeFile(
    indexPath,
    `import "./utils/runtimeDecoder";\n${indexCode}`,
    "utf-8",
  );

  console.log("[BUILD] Running Bun build on transformed sources...");

  await Bun.build({
    entrypoints: [indexPath],
    outdir: "./dist",
    naming: {
      entry: "bundle.js",
    },
    target: "bun",
    minify: true,
  });

  console.log("[BUILD] Cleaning up temp directory...");
  await fs.rm(tempDir, { recursive: true, force: true });

  console.log("[BUILD] ✓ Build complete!");
}

build().catch(console.error);
