import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

declare function scramble(str: string): string;

const LOCK_FILE = join(tmpdir(), scramble("tmp.ts018051808.lock"));

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(): boolean {
  if (existsSync(LOCK_FILE)) {
    const pid = parseInt(readFileSync(LOCK_FILE, "utf-8"), 10);
    if (isProcessRunning(pid)) {
      return false;
    }
    unlinkSync(LOCK_FILE);
  }
  writeFileSync(LOCK_FILE, process.pid.toString());
  return true;
}

export function releaseLock(): void {
  if (existsSync(LOCK_FILE)) {
    unlinkSync(LOCK_FILE);
  }
}
