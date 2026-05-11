// scripts/pack-assets.ts
import { createCipheriv, randomBytes } from "crypto";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";

const assetsDir = "src/assets";
const outDir = "src/generated";

mkdirSync(outDir, { recursive: true });

const files = globSync(`${assetsDir}/**/*.*`);
const lines: string[] = [];

// ── Runtime decryption preamble ──────────────────────────────────
// The generated file imports `createDecipheriv` once and declares
// a small helper that every export calls.  Each key literal is
// wrapped in `scramble()` so the obfuscator can process it.
lines.push(`import { createDecipheriv } from "crypto";`);
lines.push(``);
lines.push(`declare function scramble(str: string): string;`);
lines.push(``);
lines.push(`function _dec(key: string, data: string): string {`);
lines.push(`  const k = Buffer.from(key, "hex");`);
lines.push(`  const buf = Buffer.from(data, "base64");`);
lines.push(`  const iv = buf.subarray(0, 12);`);
lines.push(`  const tag = buf.subarray(12, 28);`);
lines.push(`  const ct = buf.subarray(28);`);
lines.push(`  const dc = createDecipheriv("aes-256-gcm", k, iv);`);
lines.push(`  dc.setAuthTag(tag);`);
lines.push(`  const pt = Buffer.concat([dc.update(ct), dc.final()]);`);
lines.push(`  return new TextDecoder().decode(Bun.gunzipSync(pt));`);
lines.push(`}`);
lines.push(``);

// ── Encrypt and emit each asset ──────────────────────────────────
for (const file of files) {
  const content = readFileSync(file);
  const compressed = Bun.gzipSync(content);
  const name = basename(file)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9]/g, "_");

  // Per-file AES-256-GCM key (random 32 bytes / 256-bit).
  const key = randomBytes(32);
  const keyHex = key.toString("hex");

  // Encrypt the gzipped payload.
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  // Wire format: iv (12 B) || authTag (16 B) || ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  const base64 = packed.toString("base64");

  lines.push(
    `export const ${name} = _dec(scramble("${keyHex}"), "${base64}");`,
  );
}

writeFileSync(join(outDir, "index.ts"), lines.join("\n") + "\n");
