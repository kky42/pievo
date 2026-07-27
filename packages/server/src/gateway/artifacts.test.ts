import { expect, test } from "vitest";

import { safeRelPath } from "./artifacts.js";

// Pure path-safety unit tests (no DB). The NUL case is the pg-hardening one:
// artifact_files.path is a Postgres text column, which rejects U+0000 - a
// hostile manifest path carrying one must be dropped at validation, not allowed
// through to 500 the whole sync on the row write. (No real filesystem can
// produce a NUL filename, so rejecting is always correct.)
test("safeRelPath rejects a NUL-carrying path", () => {
  expect(safeRelPath("a\u0000b.md")).toBeNull();
  expect(safeRelPath("dir/\u0000/file.md")).toBeNull();
});

test("safeRelPath preserves exact literal paths and rejects aliases", () => {
  expect(safeRelPath("notes/report.md")).toBe("notes/report.md");
  expect(safeRelPath(" report.md ")).toBe(" report.md ");
  expect(safeRelPath("reports/*.md")).toBe("reports/*.md");
  expect(safeRelPath("dir\\win\\file.md")).toBe("dir\\win\\file.md");
  expect(safeRelPath("x".repeat(5000))).toBe("x".repeat(5000));
  expect(safeRelPath("./notes//report.md")).toBeNull();
  expect(safeRelPath("/etc/passwd")).toBeNull();
  expect(safeRelPath("../escape.md")).toBeNull();
});
