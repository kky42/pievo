import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  prepareWindowsCliSpawn,
  startCliJsonRun
} from "../src/pi_run/process-runner.js";
import { createFakeCliCommand } from "./support/fakes.js";

async function createShimTarget(tempDir, relativeTarget, shimName = "tool.cmd") {
  const targetPath = path.join(tempDir, ...relativeTarget.split("\\"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, "", "utf8");

  const shimPath = path.join(tempDir, shimName);
  await fs.writeFile(
    shimPath,
    [
      "@echo off",
      '"%~dp0\\node.exe" "%~dp0\\ignored.js" %*',
      `"%~dp0\\${relativeTarget}" %*`,
      ""
    ].join("\r\n"),
    "utf8"
  );

  return targetPath;
}

test("prepareWindowsCliSpawn launches npm shim exe targets directly", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-win-exe-shim-"));
  try {
    const targetPath = await createShimTarget(
      tempDir,
      "node_modules\\tool\\bin\\tool.exe"
    );

    const prepared = prepareWindowsCliSpawn("tool", ["-p", "hello"], {
      env: {
        PATH: tempDir,
        PATHEXT: ".cmd;.exe"
      }
    });

    assert.equal(prepared.command, targetPath);
    assert.deepEqual(prepared.args, ["-p", "hello"]);
    assert.deepEqual(prepared.options, { windowsHide: true });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("startCliJsonRun includes stderr tail on non-zero exit", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-stderr-tail-"));
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "json-cli",
    `process.stderr.write("No session found matching stale-session\\n");
process.exit(1);
`
  );

  try {
    const run = startCliJsonRun({
      command: "json-cli",
      args: [],
      displayName: "json-cli",
      parseEventLine: () => null,
      isTerminalEvent: () => false
    });

    await assert.rejects(
      run.done,
      /json-cli exited with code 1[\s\S]*No session found matching stale-session/
    );
  } finally {
    fakeCommand.restorePath();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("startCliJsonRun rejects stdout stream errors without crashing the process", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-stdout-error-"));
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "json-cli",
    `setInterval(() => {}, 1000);\n`
  );

  try {
    const run = startCliJsonRun({
      command: "json-cli",
      args: [],
      displayName: "json-cli",
      parseEventLine: () => null,
      isTerminalEvent: () => false
    });

    run.child.stdout.emit("error", new Error("pipe exploded"));
    await assert.rejects(run.done, /json-cli stdout stream error: pipe exploded/);
  } finally {
    fakeCommand.restorePath();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("prepareWindowsCliSpawn launches npm shim JavaScript targets through node", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-win-js-shim-"));
  try {
    const targetPath = await createShimTarget(tempDir, "node_modules\\pkg\\bin\\cli.js", "pi.cmd");

    const prepared = prepareWindowsCliSpawn("pi", ["--version"], {
      env: {
        PATH: tempDir,
        PATHEXT: ".cmd;.exe"
      }
    });

    assert.equal(prepared.command, process.execPath);
    assert.deepEqual(prepared.args, [targetPath, "--version"]);
    assert.deepEqual(prepared.options, { windowsHide: true });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
