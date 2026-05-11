import { $ } from "bun";

export interface ShellResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function run(
  parts: TemplateStringsArray,
  ...values: string[]
): Promise<ShellResult> {
  const escaped = values.map((v) => $.escape(v));
  let command = parts[0] ?? "";
  for (let i = 0; i < escaped.length; i++) {
    command += escaped[i] + (parts[i + 1] ?? "");
  }

  const result = await $`${{ raw: command }}`.nothrow().quiet();

  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
