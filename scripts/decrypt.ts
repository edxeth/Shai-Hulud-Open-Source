import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as zlib from "zlib";

const gunzip = promisify(zlib.gunzip);

interface EncryptedPackage {
  envelope: string;
  key: string;
}

interface FileEntry {
  label: string;
  paths: string[];
}

const PART_FILE_PATTERN = /\.json\.p(\d+)$/;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findJsonFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonFiles(fullPath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".json") || PART_FILE_PATTERN.test(entry.name))
    ) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function groupFiles(files: string[]): FileEntry[] {
  const partGroups = new Map<string, string[]>();
  const standalone: string[] = [];

  for (const file of files) {
    if (PART_FILE_PATTERN.test(file)) {
      const baseName = file.replace(PART_FILE_PATTERN, ".json");
      if (!partGroups.has(baseName)) {
        partGroups.set(baseName, []);
      }
      partGroups.get(baseName)!.push(file);
    } else {
      standalone.push(file);
    }
  }

  const entries: FileEntry[] = [];

  for (const file of standalone) {
    entries.push({ label: file, paths: [file] });
  }

  for (const [baseName, parts] of partGroups) {
    parts.sort((a, b) => {
      const numA = parseInt(a.match(PART_FILE_PATTERN)![1]);
      const numB = parseInt(b.match(PART_FILE_PATTERN)![1]);
      return numA - numB;
    });
    entries.push({
      label: `${baseName} (merged from ${parts.length} parts)`,
      paths: parts,
    });
  }

  entries.sort((a, b) => a.label.localeCompare(b.label));
  return entries;
}

function findSiblingParts(filePath: string): FileEntry {
  const partMatch = filePath.match(/^(.+\.json)\.p\d+$/);
  if (!partMatch) {
    return { label: filePath, paths: [filePath] };
  }

  const baseJsonPath = partMatch[1];
  const dir = path.dirname(filePath);
  const baseJsonName = path.basename(baseJsonPath);
  const siblingPattern = new RegExp(
    `^${escapeRegExp(baseJsonName)}\\.p(\\d+)$`,
  );

  const dirEntries = fs.readdirSync(dir);
  const parts = dirEntries
    .filter((e) => siblingPattern.test(e))
    .sort((a, b) => {
      const numA = parseInt(a.match(siblingPattern)![1]);
      const numB = parseInt(b.match(siblingPattern)![1]);
      return numA - numB;
    })
    .map((e) => path.join(dir, e));

  if (parts.length === 0) {
    return { label: filePath, paths: [filePath] };
  }

  return {
    label: `${baseJsonPath} (merged from ${parts.length} parts)`,
    paths: parts,
  };
}

function resolveJsonPaths(input: string): FileEntry[] {
  const stat = fs.statSync(input, { throwIfNoEntry: false });
  if (!stat) {
    console.error(`Path not found: ${input}`);
    process.exit(1);
  }
  if (stat.isFile()) {
    if (PART_FILE_PATTERN.test(input)) {
      return [findSiblingParts(input)];
    }
    return [{ label: input, paths: [input] }];
  }
  if (stat.isDirectory()) {
    const files = findJsonFiles(input);
    if (files.length === 0) {
      console.error(`No .json or .json.p* files found under: ${input}`);
      process.exit(1);
    }
    return groupFiles(files);
  }
  console.error(`Unsupported path type: ${input}`);
  process.exit(1);
}

async function decryptProviderResults(
  encryptedPackage: EncryptedPackage,
  privateKeyPem: string,
): Promise<unknown> {
  try {
    const combined = Buffer.from(encryptedPackage.envelope, "base64");
    const encryptedKey = Buffer.from(encryptedPackage.key, "base64");

    const iv = combined.subarray(0, 12);
    const encryptedData = combined.subarray(12);

    const ciphertext = encryptedData.subarray(0, encryptedData.length - 16);
    const authTag = encryptedData.subarray(encryptedData.length - 16);

    const aesKey = crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      encryptedKey,
    );

    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAuthTag(authTag);

    const compressed = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const decompressed = await gunzip(compressed);
    const decrypted = JSON.parse(decompressed.toString("utf-8"));

    return decrypted;
  } catch (error) {
    throw new Error(
      `Decryption failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage: ts-node decrypt.ts <private-key-path> <encrypted-json-path-or-dir>",
    );
    process.exit(1);
  }

  const [privateKeyPath, encryptedJsonPath] = args;
  const privateKeyPem = fs.readFileSync(privateKeyPath, "utf-8");
  const fileEntries = resolveJsonPaths(encryptedJsonPath);
  const multiple = fileEntries.length > 1;

  let failures = 0;

  for (const entry of fileEntries) {
    try {
      const raw = entry.paths.map((p) => fs.readFileSync(p, "utf-8")).join("");
      const encryptedPackage: EncryptedPackage = JSON.parse(raw);

      if (!encryptedPackage.envelope || !encryptedPackage.key) {
        if (multiple) {
          console.error(
            `Skipping (not an encrypted package): ${entry.label}`,
          );
          continue;
        }
        throw new Error("JSON does not contain 'envelope' and 'key' fields");
      }

      const decrypted = await decryptProviderResults(
        encryptedPackage,
        privateKeyPem,
      );

      if (multiple) {
        console.log(`\n--- ${entry.label} ---`);
      }
      console.log(JSON.stringify(decrypted, null, 2));
    } catch (error) {
      failures++;
      console.error(
        `Error${multiple ? ` (${entry.label})` : ""}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
}

main();

