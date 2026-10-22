import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ensureBinShim } from "./bin-shim.js";

describe("ensureBinShim", () => {
  test("writes to the first candidate and returns its path + onPath + written", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const r = ensureBinShim({
      env: { npm_config_prefix: "/opt/node", PATH: `/opt/node/bin${path.delimiter}/usr/bin` },
      homedir: () => "/home/u",
      entry: () => "/opt/node/lib/node_modules/@kky42/pievo/dist/cli.js",
      readShim: () => null,
      writeShim: (dir) => void wrote.push(dir),
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([path.join("/opt/node", "bin")]);
    expect(r).toEqual({ path: path.join("/opt/node", "bin", "pievo"), onPath: true, written: true });
    expect(out.join("")).toBe("");
  });

  test("falls back to ~/.local/bin when the global bin is unwritable (EACCES), with PATH guidance", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const r = ensureBinShim({
      env: { npm_config_prefix: "/usr/local", PATH: "/usr/bin" },
      homedir: () => "/home/u",
      entry: () => "/usr/local/lib/node_modules/@kky42/pievo/dist/cli.js",
      readShim: () => null,
      writeShim: (dir) => {
        if (dir === path.join("/usr/local", "bin")) throw new Error("EACCES");
        wrote.push(dir);
      },
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([path.join("/home/u", ".local", "bin")]);
    expect(r.path).toBe(path.join("/home/u", ".local", "bin", "pievo"));
    expect(r.onPath).toBe(false);
    expect(r.written).toBe(true);
    expect(out.join("")).toContain("add it to your PATH");
    expect(out.join("")).toContain(path.join("/home/u", ".local", "bin"));
  });

  test("every candidate failing → best-effort null + an announced line, never throws", () => {
    const out: string[] = [];
    const r = ensureBinShim({
      env: {},
      homedir: () => "/home/u",
      entry: () => "/usr/local/lib/node_modules/@kky42/pievo/dist/cli.js",
      readShim: () => null,
      writeShim: () => {
        throw new Error("EROFS");
      },
      out: (s) => out.push(s),
    });
    expect(r).toEqual({ path: null, onPath: false, written: false });
    expect(out.join("")).toContain("could not write");
  });

  test("ephemeral (npx-cache) entry → skips writing, prints global-install guidance", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const r = ensureBinShim({
      env: { npm_config_prefix: "/opt/node", PATH: "/opt/node/bin" },
      homedir: () => "/home/u",
      entry: () => "/home/u/.npm/_npx/abc123/node_modules/@kky42/pievo/dist/cli.js",
      readShim: () => null,
      writeShim: (dir) => void wrote.push(dir),
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([]);
    expect(r).toEqual({ path: null, onPath: false, written: false });
    expect(out.join("")).toContain("npx cache");
    expect(out.join("")).toContain("npm install -g @kky42/pievo@latest");
  });

  test("accepts the current global npm symlink without rewriting or warning", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-global-bin-"));
    const prefix = path.join(root, "prefix");
    const binDir = path.join(prefix, "bin");
    const entry = path.join(prefix, "lib", "node_modules", "@kky42", "pievo", "dist", "cli.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entry, "#!/usr/bin/env node\n");
    fs.symlinkSync(path.relative(binDir, entry), path.join(binDir, "pievo"));
    const out: string[] = [];
    try {
      const r = ensureBinShim({
        // Directly running a global npm bin does not normally export npm_config_prefix;
        // the already-valid symlink must be discovered from PATH alone.
        env: { PATH: binDir },
        homedir: () => path.join(root, "home"),
        entry: () => entry,
        writeShim: () => {
          throw new Error("must not rewrite a valid npm bin symlink");
        },
        out: (s) => out.push(s),
      });
      expect(r).toEqual({ path: path.join(binDir, "pievo"), onPath: true, written: false });
      expect(out).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite a FOREIGN `pievo`, falling through to the next candidate", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const globalBin = path.join("/opt/node", "bin", "pievo");
    const r = ensureBinShim({
      env: { npm_config_prefix: "/opt/node", PATH: `/opt/node/bin${path.delimiter}/home/u/.local/bin` },
      homedir: () => "/home/u",
      entry: () => "/opt/node/lib/node_modules/@kky42/pievo/dist/cli.js",
      readShim: (p) => (p === globalBin ? "#!/usr/bin/env node\nconsole.log('real bin')" : null),
      writeShim: (dir) => void wrote.push(dir),
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([path.join("/home/u", ".local", "bin")]);
    expect(r.path).toBe(path.join("/home/u", ".local", "bin", "pievo"));
    expect(r.written).toBe(true);
  });

  test("idempotently refreshes our OWN prior shim (marker match)", () => {
    const wrote: string[] = [];
    const globalBin = path.join("/opt/node", "bin", "pievo");
    const r = ensureBinShim({
      env: { npm_config_prefix: "/opt/node", PATH: "/opt/node/bin" },
      homedir: () => "/home/u",
      entry: () => "/opt/node/lib/node_modules/@kky42/pievo/dist/cli.js",
      readShim: (p) => (p === globalBin ? "#!/bin/sh\nexec '/usr/bin/node' '/old/cli.js' \"$@\"\n" : null),
      writeShim: (dir) => void wrote.push(dir),
    });
    expect(wrote).toEqual([path.join("/opt/node", "bin")]);
    expect(r).toEqual({ path: globalBin, onPath: true, written: true });
  });
});
