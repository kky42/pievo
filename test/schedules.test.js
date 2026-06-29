import test from "node:test";
import assert from "node:assert/strict";

import { buildScheduleListText } from "../src/chat_adapter/common/schedules.js";
import { ScheduleCommandHandler } from "../src/chat_adapter/common/schedule-command-handler.js";
import { normalizeRunAt } from "../src/chat_adapter/common/schedule-time.js";

test("one-time schedule run_at requires seconds and timezone", () => {
  assert.equal(normalizeRunAt("2026-06-22T09:00:00+08:00"), "2026-06-22T09:00:00+08:00");
  assert.throws(
    () => normalizeRunAt("2026-06-22 09:00:00"),
    /ISO 8601 with seconds and timezone/
  );
  assert.throws(
    () => normalizeRunAt("2026-02-31T09:00:00+08:00"),
    /valid calendar time/
  );
});

test("buildScheduleListText includes schedule identity and trigger details", () => {
  const text = buildScheduleListText([
    {
      mode: "heartbeat",
      name: "pulse",
      trigger: "cron",
      cron: "*/5 * * * *",
      prompt: "check",
      enabled: true
    },
    {
      mode: "background",
      name: "once-report",
      trigger: "once",
      runAt: "2999-06-22T09:00:00+08:00",
      prompt: "report",
      enabled: true
    }
  ]);

  assert.match(text, /heartbeat/);
  assert.match(text, /pulse/);
  assert.match(text, /cron: \*\/5 \* \* \* \*/);
  assert.match(text, /background/);
  assert.match(text, /once-report/);
  assert.match(text, /once: 2999-06-22T09:00:00\+08:00/);
});

test("/schedule command lists only and rejects mutation syntax", async () => {
  const sentTexts = [];
  const session = {
    schedules: [],
    async sendText(text) {
      sentTexts.push(text);
    }
  };
  const handler = new ScheduleCommandHandler();

  await handler.handle(session, "");
  await handler.handle(session, "add background pulse */5 * * * * check");

  assert.equal(sentTexts[0], "No schedules.");
  assert.match(sentTexts[1], /only lists scheduled tasks/);
});
