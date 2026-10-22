import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** The installed `@kky42/pievo-server` launcher. */
export function serverLauncherPath(): string {
  return createRequire(import.meta.url).resolve("@kky42/pievo-server/scripts/pievo-server.mjs");
}

/** `pievo server …` delegates verbatim to the server package's lifecycle launcher. */
export async function runServer(args: string[]): Promise<number> {
  const child = spawn(process.execPath, [serverLauncherPath(), ...args], { stdio: "inherit" });
  // A terminal Ctrl-C already reaches the child through the shared process group;
  // handling it here keeps this wrapper alive until the server finishes draining.
  const forward = (signal: NodeJS.Signals) => {
    if (signal !== "SIGINT") child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}
