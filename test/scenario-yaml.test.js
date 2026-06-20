import test from "node:test";
import assert from "node:assert/strict";

import { parseYamlScenario } from "../e2e/scenario-yaml.js";

test("parseYamlScenario parses editable multi-step chat scenarios", () => {
  const scenario = parseYamlScenario(`
name: sample
mode: group
steps:
  - id: first
    messages:
      - from: Alice
        handle: "@alice"
        text: |
          @relaybot hello
          second line
    expect:
      toolCalls:
        send_reply: 1
      replies:
        - contains: hello
          maxLength: 100
`);

  assert.equal(scenario.name, "sample");
  assert.equal(scenario.steps.length, 1);
  assert.equal(scenario.steps[0].messages[0].text, "@relaybot hello\nsecond line");
  assert.deepEqual(scenario.steps[0].expect.toolCalls, { send_reply: 1 });
  assert.equal(scenario.steps[0].expect.replies[0].maxLength, 100);
});
