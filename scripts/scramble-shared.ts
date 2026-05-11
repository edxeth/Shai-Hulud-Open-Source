import { randomBytes } from "crypto";
import { promises as fs } from "fs";

import type { StringScrambler } from "../src/utils/stringtool";

/**
 * Sentinel string in `src/utils/runtimeDecoder.ts` that the build
 * pipelines rewrite with the freshly-generated passphrase for the
 * current build.
 *
 * Keep this in sync with the literal in `runtimeDecoder.ts`.
 */
export const RUNTIME_PASSPHRASE_PLACEHOLDER = "__SCRAMBLE_BUILD_PASSPHRASE__";

/**
 * Path (relative to the project root) of the runtime decoder source
 * file whose passphrase placeholder gets rewritten per build.
 */
export const RUNTIME_DECODER_PATH = "src/utils/runtimeDecoder.ts";

/**
 * Regex used to find `scramble(...)` calls in source code.
 *
 * Accepts either a double-quoted or backtick-quoted single string
 * literal as the only argument. Single-quoted strings, concatenations,
 * and template interpolations are intentionally not supported — those
 * would not survive the textual transform safely.
 */
export const SCRAMBLE_CALL_REGEX =
  /scramble\(\s*(`[\s\S]*?`|"[\s\S]*?")\s*,?\s*\)/g;

/**
 * Regex used to strip out `declare function scramble(...)` lines from
 * the transformed source. The runtime has no `scramble` symbol — only
 * `beautify` — so the declaration is dead weight at runtime.
 */
export const SCRAMBLE_DECLARE_REGEX =
  /declare\s+function\s+scramble[^;]*;\s*\n?/g;

/**
 * Generates a fresh random passphrase to be used for this build.
 *
 * The passphrase is 64 hex characters (32 random bytes). It is meant to
 * be ephemeral: it is generated once per build, used to encode every
 * `scramble(...)` call site, and then baked into the runtime decoder so
 * that decoding works at runtime without any environment variables.
 */
export function generateBuildPassphrase(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Transforms a single source file's text by replacing every
 * `scramble("...")` / `` scramble(`...`) `` call with a
 * `beautify("<base64>")` call encoded with the supplied
 * scrambler, and stripping out the matching `declare function scramble`
 * statements.
 *
 * The transform is purely textual; it makes no attempt to parse the
 * source. The constraints documented on `SCRAMBLE_CALL_REGEX` apply.
 *
 * @param code         The original source code.
 * @param scrambler    The `StringScrambler` to use for encoding.
 * @param logPrefix    Optional log prefix for build output (e.g. "[BUILD]").
 * @param sourceLabel  Optional label (filename) included in log output.
 */
export function transformSource(
  code: string,
  scrambler: StringScrambler,
  logPrefix = "[SCRAMBLE]",
  sourceLabel?: string,
): { code: string; replacements: number } {
  let replacements = 0;

  const transformed = code.replace(
    SCRAMBLE_CALL_REGEX,
    (_match, str: string) => {
      const inner = str.slice(1, -1);
      const encoded = scrambler.encode(inner);
      replacements++;
      const where = sourceLabel ? ` in ${sourceLabel}` : "";
      console.log(
        `${logPrefix} scramble(${str.slice(0, 32)}...) -> beautify("${encoded.slice(0, 16)}...")${where}`,
      );
      return `beautify(${JSON.stringify(encoded)})`;
    },
  );

  const stripped = transformed.replace(SCRAMBLE_DECLARE_REGEX, "");

  return { code: stripped, replacements };
}

/**
 * Reads the runtime decoder source, replaces the build-time placeholder
 * passphrase with the supplied real passphrase, and returns the new
 * contents. The original file on disk is NOT modified — callers are
 * expected to write the rewritten contents to a temp/output location.
 *
 * Throws if the placeholder cannot be found, which would otherwise
 * silently produce a bundle that decodes to garbage at runtime.
 */
export async function rewriteRuntimeDecoder(
  decoderPath: string,
  passphrase: string,
): Promise<string> {
  const original = await fs.readFile(decoderPath, "utf-8");

  if (!original.includes(RUNTIME_PASSPHRASE_PLACEHOLDER)) {
    throw new Error(
      `[SCRAMBLE] Could not find passphrase placeholder ` +
        `"${RUNTIME_PASSPHRASE_PLACEHOLDER}" in ${decoderPath}. ` +
        `The runtime decoder must contain the sentinel string so the ` +
        `build pipeline can inject the per-build passphrase.`,
    );
  }

  // JSON.stringify gives us a safely-quoted JS string literal.
  const literal = JSON.stringify(passphrase);

  // The placeholder appears inside an existing string literal, e.g.
  //   const PASSPHRASE = "__SCRAMBLE_BUILD_PASSPHRASE__";
  // We want to end up with:
  //   const PASSPHRASE = "<hex>";
  // so we replace the *quoted placeholder* (including its surrounding
  // double-quotes) with the JSON-encoded passphrase literal.
  const quotedPlaceholder = `"${RUNTIME_PASSPHRASE_PLACEHOLDER}"`;
  if (!original.includes(quotedPlaceholder)) {
    throw new Error(
      `[SCRAMBLE] Found placeholder text but not the expected quoted ` +
        `form ${quotedPlaceholder} in ${decoderPath}. The placeholder ` +
        `must appear as a standalone double-quoted string literal.`,
    );
  }

  return original.split(quotedPlaceholder).join(literal);
}
