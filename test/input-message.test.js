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

test("buildTurnInputMessage renders all local attachments as one compact list", () => {
  assert.equal(
    buildTurnInputMessage({
      promptText: "inspect",
      attachments: [
        { kind: "photo", localPath: "/tmp/input.jpg" },
        { kind: "document", localPath: "/tmp/spec.pdf" }
      ]
    }),
    [
      "inspect",
      "",
      "Attached files:",
      "- kind: photo, path: /tmp/input.jpg",
      "- kind: document, path: /tmp/spec.pdf"
    ].join("\n")
  );
});

test("buildTurnInputMessage renders unavailable attachment paths", () => {
  assert.equal(
    buildTurnInputMessage({
      promptText: "",
      attachments: [
        { kind: "photo", localPath: "" }
      ]
    }),
    [
      "Attached file:",
      "- kind: photo, path: unavailable"
    ].join("\n")
  );
});
