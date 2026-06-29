import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildPiArgs } from "../src/pi_run/args.js";
import {
  detectPiSandboxFlagSupport,
  resetPiFeatureDetectionCache,
  startPiRun
} from "../src/pi_run/runner.js";
import { PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/common/output-instructions.js";
import { createFakeCliCommand } from "./support/fakes.js";

function flagValues(args, flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) values.push(args[index + 1]);
  }
  return values;
}

function flagValue(args, flag) {
  return flagValues(args, flag).at(-1);
}

function assertBasePrintJsonInvocation(args, message) {
  assert.equal(args.at(-1), message);
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("--approve"));
  assert.equal(flagValue(args, "--mode"), "json");
}

test("buildPiArgs creates approved print-json runs", () => {
  const args = buildPiArgs({ message: "hello" });

  assertBasePrintJsonInvocation(args, "hello");
  assert.equal(flagValue(args, "--model"), "deepseek/deepseek-v4-flash");
  assert.equal(flagValue(args, "--thinking"), "high");
});

test("buildPiArgs can resume a Pi session and use an explicit session directory", () => {
  const args = buildPiArgs({
    sessionId: "session-123",
    sessionDir: "/tmp/pi-sessions",
    message: "continue",
    model: "default",
    reasoningEffort: "default"
  });

  assertBasePrintJsonInvocation(args, "continue");
  assert.equal(flagValue(args, "--session-dir"), "/tmp/pi-sessions");
  assert.equal(flagValue(args, "--session"), "session-123");
  assert.equal(flagValue(args, "--model"), undefined);
  assert.equal(flagValue(args, "--thinking"), undefined);
});

test("buildPiArgs maps auto modes to pi-sandbox flags only when supported", () => {
  assert.equal(flagValue(buildPiArgs({ message: "hello", autoMode: "low", supportsSandboxFlag: true }), "--sandbox"), "read-only");
  assert.equal(flagValue(buildPiArgs({ message: "hello", autoMode: "medium", supportsSandboxFlag: true }), "--sandbox"), "workspace-write");
  assert.equal(flagValue(buildPiArgs({ message: "hello", autoMode: "high", supportsSandboxFlag: true }), "--sandbox"), "danger-full-access");
  assert.equal(flagValue(buildPiArgs({ message: "hello", autoMode: "high", supportsSandboxFlag: false }), "--sandbox"), undefined);
});

test("buildPiArgs can still request Pi CLI defaults explicitly", () => {
  const args = buildPiArgs({
    message: "hello",
    model: "default",
    reasoningEffort: "default"
  });

  assertBasePrintJsonInvocation(args, "hello");
  assert.equal(flagValue(args, "--model"), undefined);
  assert.equal(flagValue(args, "--thinking"), undefined);
});

test("private relay instructions include runtime local timezone", () => {
  assert.match(
    PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS,
    /Runtime local timezone: .+ \(UTC[+-]\d{2}:\d{2}\)/
  );
  assert.doesNotMatch(PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS, /\{\{local_timezone\}\}/);
});

test("buildPiArgs appends model, thinking, system prompt, extension paths, and skill paths", () => {
  const freshArgs = buildPiArgs({
    message: "hello",
    model: "deepseek/deepseek-v4-flash",
    reasoningEffort: "high",
    developerInstructions: PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS,
    extensionPaths: ["/tmp/pievo-tools.ts"],
    skillPaths: ["/tmp/loop-skill"]
  });
  const resumedArgs = buildPiArgs({
    sessionId: "session-123",
    message: "hello",
    developerInstructions: PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS
  });

  assertBasePrintJsonInvocation(freshArgs, "hello");
  assert.equal(flagValue(freshArgs, "--append-system-prompt"), PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS);
  assert.deepEqual(flagValues(freshArgs, "--extension"), ["/tmp/pievo-tools.ts"]);
  assert.deepEqual(flagValues(freshArgs, "--skill"), ["/tmp/loop-skill"]);

  assertBasePrintJsonInvocation(resumedArgs, "hello");
  assert.equal(flagValue(resumedArgs, "--append-system-prompt"), PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS);
  assert.equal(flagValue(resumedArgs, "--session"), "session-123");
});

test("startPiRun invokes pi from the requested workdir and detects sandbox support", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-pi-args-"));
  const workdir = path.join(tempDir, "workspace");
  await fs.mkdir(workdir);
  await fs.writeFile(path.join(workdir, "cwd-marker.txt"), "ok", "utf8");
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "pi",
    `import fs from "node:fs";
import path from "node:path";

if (process.argv.includes("-h")) {
  process.stdout.write("Options:\\n  --sandbox <value>\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  cwdBasename: path.basename(process.cwd()),
  hasCwdMarker: fs.existsSync("cwd-marker.txt")
}) + "\\n");
`
  );

  resetPiFeatureDetectionCache();

  try {
    const run = startPiRun({
      workdir,
      message: "hello",
      autoMode: "low"
    });

    const chunks = [];
    run.child.stdout.setEncoding("utf8");
    run.child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    await run.done;

    const output = JSON.parse(chunks.join("").trim());
    assertBasePrintJsonInvocation(output.args, "hello");
    assert.equal(flagValue(output.args, "--sandbox"), "read-only");
    assert.deepEqual(flagValues(output.args, "--extension"), [path.resolve("src/pi_tools/extension.ts")]);
    assert.deepEqual(flagValues(output.args, "--skill"), [
      path.resolve("src/skills/loop"),
      path.resolve("src/skills/pievo-feedback")
    ]);
    assert.equal(output.cwdBasename, "workspace");
    assert.equal(output.hasCwdMarker, true);
  } finally {
    fakeCommand.restorePath();
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("startPiRun can omit the Pievo tool extension while keeping built-in skills", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-pi-no-tools-"));
  const workdir = path.join(tempDir, "workspace");
  await fs.mkdir(workdir);
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "pi",
    `if (process.argv.includes("-h")) {
  process.stdout.write("Options:\\n  --sandbox <value>\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
`
  );

  resetPiFeatureDetectionCache();

  try {
    const run = startPiRun({
      workdir,
      message: "hello",
      autoMode: "low",
      enablePievoTools: false
    });

    const chunks = [];
    run.child.stdout.setEncoding("utf8");
    run.child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    await run.done;

    const output = JSON.parse(chunks.join("").trim());
    assertBasePrintJsonInvocation(output.args, "hello");
    assert.equal(flagValue(output.args, "--sandbox"), "read-only");
    assert.deepEqual(flagValues(output.args, "--extension"), []);
    assert.deepEqual(flagValues(output.args, "--skill"), [
      path.resolve("src/skills/loop"),
      path.resolve("src/skills/pievo-feedback")
    ]);
  } finally {
    fakeCommand.restorePath();
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("detectPiSandboxFlagSupport returns false when pi help does not expose the sandbox flag", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-pi-detect-"));
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "pi",
    `process.stdout.write("Options:\\n  --mode <mode>\\n");
`
  );

  resetPiFeatureDetectionCache();

  try {
    assert.equal(detectPiSandboxFlagSupport(), false);
  } finally {
    fakeCommand.restorePath();
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("detectPiSandboxFlagSupport caches sandbox support per workdir", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-pi-detect-cwd-"));
  const workdirWithoutFlag = path.join(tempDir, "without-flag");
  const workdirWithFlag = path.join(tempDir, "with-flag");
  await fs.mkdir(workdirWithoutFlag);
  await fs.mkdir(workdirWithFlag);
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "pi",
    `if (process.cwd().endsWith("with-flag")) {
  process.stdout.write("Options:\\n  --sandbox <value>\\n");
} else {
  process.stdout.write("Options:\\n  --mode <mode>\\n");
}
`
  );

  resetPiFeatureDetectionCache();

  try {
    assert.equal(detectPiSandboxFlagSupport({ cwd: workdirWithoutFlag }), false);
    assert.equal(detectPiSandboxFlagSupport({ cwd: workdirWithFlag }), true);
    assert.equal(detectPiSandboxFlagSupport({ cwd: workdirWithoutFlag }), false);
  } finally {
    fakeCommand.restorePath();
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
