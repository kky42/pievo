import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

let home: string | undefined;
afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = undefined;
  delete process.env.PIEVO_HOME;
  vi.resetModules();
});

describe("connections config", () => {
  test("stores one active URL and a token per server with owner-only modes", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-connections-"));
    process.env.PIEVO_HOME = home;
    const config = await import("./config.js");
    config.saveActiveConnection("https://one.test/", "dk_one");
    config.saveActiveConnection("https://two.test", "dk_two");

    expect(config.activeConnection()).toEqual({ serverUrl: "https://two.test", deviceToken: "dk_two" });
    expect(config.connectionFor("https://one.test/")?.deviceToken).toBe("dk_one");
    expect(fs.statSync(config.CONNECTIONS_FILE).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  test("does not read legacy server-url/device-token files", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-connections-legacy-"));
    fs.writeFileSync(path.join(home, "server-url"), "https://old.test");
    fs.writeFileSync(path.join(home, "device-token"), "dk_old");
    process.env.PIEVO_HOME = home;
    const config = await import("./config.js");
    expect(config.activeConnection()).toBeUndefined();
  });

  test("canonicalizes equivalent origins and rejects non-origin URLs", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-connections-origin-"));
    process.env.PIEVO_HOME = home;
    const config = await import("./config.js");
    expect(config.normalizeServerUrl("HTTPS://ONE.TEST:443/")).toBe("https://one.test");
    expect(config.validServerUrl("https://one.test/path")).toBe(false);
    expect(config.validServerUrl("https://user:secret@one.test")).toBe(false);
  });

  test("uses distinct outboxes for distinct servers", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-connections-outbox-"));
    process.env.PIEVO_HOME = home;
    const { serverOutboxPath } = await import("./config.js");
    expect(serverOutboxPath("https://one.test")).not.toBe(serverOutboxPath("https://two.test"));
    expect(serverOutboxPath("HTTPS://ONE.TEST:443/")).toBe(serverOutboxPath("https://one.test"));
  });
});
