import { StringScrambler } from "./stringtool";

// This passphrase is a build-time placeholder. The build pipeline
// (`scripts/build.ts` / `scripts/build-plugin.ts`) rewrites the literal
// below with a fresh random passphrase generated for that build, so the
// runtime decoder uses the exact same key that was used to encode the
// strings via `scramble(...)`.
//
// IMPORTANT: Do not change this sentinel string without updating the
// build scripts that look for it. It must remain a single string literal
// on its own so a simple textual replacement can swap it out.
const PASSPHRASE = "__SCRAMBLE_BUILD_PASSPHRASE__";

const runtimeScrambler = new StringScrambler(PASSPHRASE);

export function beautify(blob: string): string {
  return runtimeScrambler.decode(blob);
}

declare global {
  var beautify: (blob: string) => string;
}

(globalThis as unknown as { beautify: (blob: string) => string }).beautify =
  beautify;
