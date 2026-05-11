import { spawn } from "child_process";

import { logUtil } from "./logger";

export function daemonize(): boolean {
  if (process.env["__DAEMONIZED"]) {
    return false;
  }

  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(), // or a specific directory
    env: { ...process.env, __DAEMONIZED: "1" },
  });

  child.on("error", (err) => {
    logUtil.log(`Failed to background: ${err.message}`);
  });

  child.unref();

  if (child.pid) {
    logUtil.log(`Backgrounded with PID ${child.pid}`);
  }

  return true;
}
