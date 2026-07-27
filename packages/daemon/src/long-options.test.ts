import { describe, expect, test } from "vitest";

import { parseLongOptions } from "./long-options.js";

describe("parseLongOptions", () => {
  test("supports the interactive/log policy where every non-boolean option takes a value", () => {
    expect(parseLongOptions(
      ["loop-1", "--limit=5", "--since", "yesterday", "--json", "extra"],
      (key) => key !== "json",
    )).toEqual({
      positional: ["loop-1", "extra"],
      flags: { limit: "5", since: "yesterday", json: true },
      occurrences: [
        { key: "limit", value: "5" },
        { key: "since", value: "yesterday" },
        { key: "json", value: true },
      ],
    });
  });

  test("supports the show policy where only known value options consume the next token", () => {
    expect(parseLongOptions(
      ["--server-url", "https://srv.test", "--bogus", "loop-1", "--json=false"],
      (key) => key === "server-url",
    )).toEqual({
      positional: ["loop-1"],
      flags: { "server-url": "https://srv.test", bogus: true, json: "false" },
      occurrences: [
        { key: "server-url", value: "https://srv.test" },
        { key: "bogus", value: true },
        { key: "json", value: "false" },
      ],
    });
  });
});
