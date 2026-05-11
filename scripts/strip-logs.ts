/**
 * Build-time transform that strips all `logUtil.<level>(...)` call
 * statements from source code so they are completely absent from the
 * bundle — including argument evaluation.
 *
 * Uses balanced-paren counting with string/template-literal awareness
 * so nested expressions like `logUtil.info(`batch ${arr.join(",")}`)`
 * are handled correctly.
 */

const LOG_CALL_START = /logUtil\.(log|info|warn|error)\s*\(/g;

/**
 * Advances past a string literal (single-quoted, double-quoted, or
 * backtick template) starting at `pos`. Returns the index immediately
 * after the closing quote.
 */
function skipString(code: string, pos: number): number {
  const quote = code[pos]; // one of ' " `
  let i = pos + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2; // skip escaped char
      continue;
    }
    if (quote === "`" && ch === "$" && code[i + 1] === "{") {
      // Template interpolation — skip into the expression and count
      // braces so we resurface after the closing `}`.
      i += 2;
      let depth = 1;
      while (i < code.length && depth > 0) {
        const c = code[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === '"' || c === "'" || c === "`") {
          i = skipString(code, i);
          continue;
        } else if (c === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    if (ch === quote) {
      return i + 1; // past closing quote
    }
    i++;
  }
  return i; // unterminated — return end of file
}

/**
 * Starting right after the opening `(`, finds the index of the
 * matching `)`. Returns -1 if unbalanced.
 */
function findClosingParen(code: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    } else if (ch === "\\") {
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

export function stripLogCalls(
  code: string,
  logPrefix = "[STRIP-LOGS]",
  sourceLabel?: string,
): { code: string; stripped: number } {
  let result = "";
  let lastIndex = 0;
  let stripped = 0;

  let match: RegExpExecArray | null;
  LOG_CALL_START.lastIndex = 0;

  while ((match = LOG_CALL_START.exec(code)) !== null) {
    const callStart = match.index;
    const afterOpenParen = match.index + match[0].length;

    const closeParen = findClosingParen(code, afterOpenParen);
    if (closeParen === -1) break; // unbalanced — bail out safely

    // Consume the closing paren
    let end = closeParen + 1;

    // Consume optional semicolon + trailing whitespace/newline
    if (code[end] === ";") end++;
    if (code[end] === "\n") end++;

    // Replace the entire statement with nothing
    result += code.slice(lastIndex, callStart);
    lastIndex = end;
    stripped++;
  }

  result += code.slice(lastIndex);

  if (stripped > 0) {
    const where = sourceLabel ? ` in ${sourceLabel}` : "";
    console.log(`${logPrefix} Stripped ${stripped} logUtil call(s)${where}`);
  }

  return { code: result, stripped };
}
