import test from "node:test";
import assert from "node:assert/strict";

import { buildTurnInputMessage } from "../src/pi_run/input-message.js";

test("buildTurnInputMessage returns plain prompt when there are no attachments", () => {
  assert.equal(
    buildTurnInputMessage({
      promptText: "  inspect this  ",
      attachments: []
    }),
    "inspect this"
  );
});

test("buildTurnInputMessage includes each local attachment for model context", () => {
  const message = buildTurnInputMessage({
    promptText: "inspect",
    attachments: [
      { kind: "photo", localPath: "/tmp/input.jpg" },
      { kind: "document", localPath: "/tmp/spec.pdf" }
    ]
  });

  assert.match(message, /^inspect/);
  assert.match(message, /kind: photo/);
  assert.match(message, /path: \/tmp\/input\.jpg/);
  assert.match(message, /kind: document/);
  assert.match(message, /path: \/tmp\/spec\.pdf/);
});

test("buildTurnInputMessage represents unavailable attachment paths", () => {
  const message = buildTurnInputMessage({
    promptText: "",
    attachments: [
      { kind: "photo", localPath: "" }
    ]
  });

  assert.match(message, /kind: photo/);
  assert.match(message, /path: unavailable/);
});
