import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { FileChange, FileSource } from "./types";

/**
 * Mapping of repository-relative target paths to their content source.
 *
 * Keys are the destination paths to write inside the repository (e.g.
 * "README.md", "config/license.txt"). Values describe where the content
 * comes from — either inline or a local file path to read at runtime.
 */
export type FileSourceMap = Record<string, FileSource | string>;

/**
 * Resolves a {@link FileSourceMap} into concrete {@link FileChange}s by
 * loading any disk-backed entries.
 *
 * Resolution rules:
 *
 *   - If a value is a plain string, it is treated as inline UTF-8 content
 *     (shorthand for `{ content: <string> }`). This preserves backwards
 *     compatibility with the original `Record<string, string>` shape.
 *   - If a value is `{ content }`, it is used verbatim.
 *   - If a value is `{ sourcePath }`, the file at that path is read from
 *     the local filesystem. Relative paths are resolved against `baseDir`
 *     (default: `process.cwd()`).
 *
 * Encoding handling for disk-backed sources:
 *
 *   - `"utf-8"` (default): file is read as text and used as-is. The
 *     downstream commit pipeline will base64-encode it before sending to
 *     the GitHub GraphQL API.
 *   - `"base64"`: file is read as raw bytes and base64-encoded. Useful
 *     when you want to ship the file through unchanged but the calling
 *     code expects a string. Note that the commit pipeline will then
 *     base64-encode the *already-base64* string a second time, which is
 *     almost never what you want — prefer `"binary"` instead.
 *   - `"binary"`: file is read as raw bytes and base64-encoded once for
 *     transport. The commit pipeline detects this via the
 *     `preEncoded: true` marker and skips its own base64 step.
 *
 * Each promise rejection from `readFile` is wrapped with the offending
 * path so failures are easy to diagnose in bulk runs.
 *
 * @param sources  The file source map to resolve.
 * @param baseDir  Directory to resolve relative `sourcePath`s against.
 *                 Defaults to `process.cwd()`.
 *
 * @returns A list of {@link FileChange}s ready to be handed to the
 *          commit service. Order matches the iteration order of the
 *          input map's keys.
 */
export async function resolveFileSources(
  sources: FileSourceMap,
  baseDir: string = process.cwd(),
): Promise<FileChange[]> {
  const entries = Object.entries(sources);

  const changes = await Promise.all(
    entries.map(async ([path, source]) => loadOne(path, source, baseDir)),
  );

  return changes;
}

/**
 * Resolves a single map entry into a {@link FileChange}, dispatching to
 * the appropriate loader based on the source shape.
 */
async function loadOne(
  path: string,
  source: FileSource | string,
  baseDir: string,
): Promise<FileChange> {
  // Shorthand: bare string ⇒ inline content.
  if (typeof source === "string") {
    return { path, content: source };
  }

  // Inline content branch.
  if ("content" in source && source.content !== undefined) {
    return { path, content: source.content };
  }

  // Disk-backed branch.
  if ("sourcePath" in source && source.sourcePath !== undefined) {
    const absolute = isAbsolute(source.sourcePath)
      ? source.sourcePath
      : resolve(baseDir, source.sourcePath);

    const encoding = source.encoding ?? "utf-8";

    try {
      if (encoding === "binary") {
        // Read raw bytes and base64-encode once for transport.
        const buf = await readFile(absolute);
        return {
          path,
          content: buf.toString("base64"),
          preEncoded: true,
        };
      }

      if (encoding === "base64") {
        // Read raw bytes and surface as a base64 string. The commit
        // pipeline will base64-encode this *again*; this branch exists
        // only for callers that explicitly want that behaviour.
        const buf = await readFile(absolute);
        return { path, content: buf.toString("base64") };
      }

      // Default: UTF-8 text.
      const text = await readFile(absolute, "utf-8");
      return { path, content: text };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load file source for "${path}" from "${absolute}": ${reason}`,
      );
    }
  }

  throw new Error(
    `Invalid FileSource for "${path}": must provide either "content" or "sourcePath".`,
  );
}
