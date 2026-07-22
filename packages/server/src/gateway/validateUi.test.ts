import { describe, expect, test } from "vitest";

import { validateUi } from "./validate.js";

describe("validateUi custom primitives", () => {
  test("accepts ordinary HTML, clears blank input, and accepts supported attributes", () => {
    expect(validateUi("  ")).toEqual({ ok: true, value: null });
    expect(validateUi("<h2>Dashboard</h2>")).toEqual({ ok: true, value: "<h2>Dashboard</h2>" });
    const html = [
      '<loop-chart series="score:Score"></loop-chart>',
      '<loop-embed file="latest.md"></loop-embed>',
      "<loop-embed match='reports/*.md'></loop-embed>",
      '<loop-calendar match="reports/*.md"></loop-calendar>',
      '<loop-kanban columns="open,merged" match="*.md"></loop-kanban>',
    ].join("");
    expect(validateUi(html)).toEqual({ ok: true, value: html });
  });

  test.each([
    ['<loop-chart metric="score"></loop-chart>', '<loop-chart> requires series="…"'],
    ['<loop-chart data-series="score"></loop-chart>', '<loop-chart> requires series="…"'],
    [`<loop-chart title='series="score"'></loop-chart>`, '<loop-chart> requires series="…"'],
    ['<loop-embed src="latest.md"></loop-embed>', '<loop-embed> requires file="…" or match="…"'],
    ['<loop-embed name="latest.md"></loop-embed>', '<loop-embed> requires file="…" or match="…"'],
    ['<loop-kanban match="*.md"></loop-kanban>', '<loop-kanban> requires columns="…"'],
  ])("rejects a primitive that would silently render empty: %s", (html, detail) => {
    expect(validateUi(html)).toEqual({ ok: false, detail });
  });

  test("rejects oversized UI instead of silently storing a truncated prefix", () => {
    expect(validateUi("x".repeat(20_001))).toEqual({
      ok: false,
      detail: "dashboard UI exceeds 20000 characters",
    });
  });
});
