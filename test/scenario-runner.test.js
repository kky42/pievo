import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { runStep } from "../e2e/scenario-runner.js";

async function withTempDir(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-scenario-runner-"));
  try {
    return await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function createIdleSession(turns) {
  return {
    isRunning: false,
    queue: [],
    schedules: [],
    async enqueueTurn(turn) {
      turns.push(turn);
    },
    async abortCurrentRun() {}
  };
}

function createState() {
  return {
    currentStepId: null,
    events: [],
    timeoutMs: 1_000
  };
}

test("runStep omits groupInput when a group step supplies an explicit prompt", async () => {
  await withTempDir(async (workdir) => {
    const turns = [];
    const state = createState();

    const result = await runStep({
      scenario: { mode: "group", name: "group prompt" },
      step: { id: "ask", prompt: "@relaybot answer directly" },
      stepIndex: 0,
      session: createIdleSession(turns),
      workdir,
      state
    });

    assert.equal(result.id, "ask");
    assert.equal(state.currentStepId, null);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].mode, "group");
    assert.equal(turns[0].promptText, "@relaybot answer directly");
    assert.equal(Object.hasOwn(turns[0], "groupInput"), false);
    assert.deepEqual(turns[0].attachments, []);
  });
});

test("runStep renders group step attachments into the group transcript", async () => {
  await withTempDir(async (workdir) => {
    const reportPath = path.join(workdir, "docs", "report.txt");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "report", "utf8");
    const turns = [];

    await runStep({
      scenario: { mode: "group", name: "group attachment" },
      step: {
        id: "inspect",
        messages: [
          { from: "Alice", handle: "alice", text: "@relaybot inspect the attached report" }
        ],
        attachments: [
          { kind: "document", path: "docs/report.txt" }
        ]
      },
      stepIndex: 0,
      session: createIdleSession(turns),
      workdir,
      state: createState()
    });

    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].attachments, []);
    assert.equal(turns[0].groupInput.messages.length, 1);
    assert.ok(turns[0].groupInput.messages[0].includes("Alice (@alice):"));
    assert.ok(turns[0].groupInput.messages[0].includes("@relaybot inspect the attached report"));
    assert.ok(turns[0].groupInput.messages[0].includes("Attached file:"));
    assert.ok(turns[0].groupInput.messages[0].includes(`- kind: document, path: ${reportPath}`));
    assert.ok(turns[0].promptText.includes("Attached file:"));
    assert.ok(turns[0].promptText.includes(`- kind: document, path: ${reportPath}`));
  });
});

test("runStep clears currentStepId when assertions fail", async () => {
  await withTempDir(async (workdir) => {
    const state = createState();

    await assert.rejects(
      () => runStep({
        scenario: { mode: "group", name: "failing expectation" },
        step: {
          id: "fail",
          prompt: "@relaybot answer",
          expect: { replies: [{ contains: "missing reply" }] }
        },
        stepIndex: 0,
        session: createIdleSession([]),
        workdir,
        state
      }),
      /replies: no text matched/
    );

    assert.equal(state.currentStepId, null);
  });
});
