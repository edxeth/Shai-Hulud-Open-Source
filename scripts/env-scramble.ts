/**
 * Build-time transform that rewrites all `process.env.SOME_KEY` member
 * expressions into `process.env[scramble("SOME_KEY")]` so that the
 * subsequent scramble transform can encode the environment variable
 * names.
 *
 * Must run BEFORE the scramble transform in the pipeline.
 *
 * Matches dot-access syntax only (`process.env.FOO`). Bracket-access
 * like `process.env["FOO"]` is left alone — the scramble transform
 * will already pick those up if they use `scramble(...)`.
 */

const PROCESS_ENV_DOT = /process\.env\.([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
 * Keys that should never be rewritten — they are resolved by the
 * runtime or Node/Bun internals and don't represent user secrets.
 */
const IGNORED_KEYS = new Set(["NODE_ENV", "TZ"]);

export function transformEnvAccess(
  code: string,
  logPrefix = "[ENV-SCRAMBLE]",
  sourceLabel?: string,
): { code: string; replacements: number } {
  let replacements = 0;

  const transformed = code.replace(PROCESS_ENV_DOT, (_match, key: string) => {
    if (IGNORED_KEYS.has(key)) return _match;
    replacements++;
    return `process.env[scramble("${key}")]`;
  });

  if (replacements > 0) {
    const where = sourceLabel ? ` in ${sourceLabel}` : "";
    console.log(
      `${logPrefix} Rewrote ${replacements} process.env access(es)${where}`,
    );
  }

  return { code: transformed, replacements };
}
