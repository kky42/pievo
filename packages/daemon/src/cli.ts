#!/usr/bin/env node
/** Pievo CLI entry. Daemon lifecycle is available only as `pievo daemon …`;
 * loop management and in-run callbacks continue through their dedicated routes. */
import { classify } from "./route.js";

async function runDaemonCommand(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case "start":
      return (await import("./daemon-lifecycle.js")).runDaemonStart(args);
    case "stop":
      return (await import("./daemon-control.js")).runDaemonStop(args);
    case "restart":
      return (await import("./daemon-lifecycle.js")).runDaemonRestart(args);
    case "status":
      return (await import("./daemon-control.js")).runDaemonStatus(args);
    default:
      process.stderr.write(command
        ? `pievo: unknown daemon command '${command}' — try \`pievo daemon --help\`\n`
        : "pievo: usage: pievo daemon <start|stop|restart|status>\n");
      return 2;
  }
}

async function main(): Promise<number> {
  const r = classify(process.argv.slice(2), process.env);
  switch (r.kind) {
    case "callback":
      return (await import("./callback.js")).runCallback(r.argv);
    case "help": {
      const help = await import("./help.js");
      return r.verb ? help.printVerbHelp(r.verb) : help.printHelp();
    }
    case "version":
      return (await import("./help.js")).printVersion();
    case "daemonCommand":
      return runDaemonCommand(r.command, r.args);
    case "create":
      return (await import("./create.js")).runCreate(r.args);
    case "skill":
      return (await import("./skill-cli.js")).runSkill(r.args);
    case "log":
      return (await import("./log.js")).runLog(r.args);
    case "show":
      return (await import("./show.js")).runShow(r.args);
    case "interactive":
      return (await import("./interactive.js")).runInteractive(r.argv);
    case "forward":
      return (await import("./callback.js")).runCallback(r.argv);
    case "home":
      return (await import("./home.js")).runHome();
    case "unknown":
      process.stderr.write(`pievo: unknown command '${r.verb}' — try \`pievo --help\`\n`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`pievo: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
