import fs from "node:fs";
import path from "node:path";

export function eventTexts(events, kinds) {
  const kindSet = new Set(kinds);
  return events.filter((event) => kindSet.has(event.kind)).map((event) => event.text ?? event.payload?.text ?? "");
}

export function countByTool(events) {
  const counts = new Map();
  for (const event of events) {
    if (event.kind !== "tool_call") continue;
    counts.set(event.tool, (counts.get(event.tool) ?? 0) + 1);
  }
  return counts;
}

export function assertCount(actual, spec, label) {
  if (spec === undefined || spec === null) return;
  if (typeof spec === "number") {
    if (actual !== spec) throw new Error(`${label}: expected count ${spec}, got ${actual}`);
    return;
  }
  if (typeof spec !== "object") return;
  if (spec.count !== undefined && actual !== Number(spec.count)) {
    throw new Error(`${label}: expected count ${spec.count}, got ${actual}`);
  }
  if (spec.min !== undefined && actual < Number(spec.min)) {
    throw new Error(`${label}: expected at least ${spec.min}, got ${actual}`);
  }
  if (spec.max !== undefined && actual > Number(spec.max)) {
    throw new Error(`${label}: expected at most ${spec.max}, got ${actual}`);
  }
}

export function textMatchesExpectation(text, expectation) {
  if (typeof expectation === "string") return text.includes(expectation);
  if (expectation.equals !== undefined && text !== String(expectation.equals)) return false;
  if (expectation.contains !== undefined && !text.includes(String(expectation.contains))) return false;
  if (expectation.notContains !== undefined && text.includes(String(expectation.notContains))) return false;
  if (expectation.matches !== undefined && !new RegExp(String(expectation.matches), "s").test(text)) return false;
  if (expectation.maxLength !== undefined && text.length > Number(expectation.maxLength)) return false;
  if (expectation.minLength !== undefined && text.length < Number(expectation.minLength)) return false;
  return true;
}

export function assertTextExpectations(texts, expectations, label) {
  if (!expectations) return;
  if (!Array.isArray(expectations)) {
    assertCount(texts.length, expectations, label);
    return;
  }

  let cursor = 0;
  for (const expectation of expectations) {
    let foundIndex = -1;
    for (let index = cursor; index < texts.length; index += 1) {
      if (textMatchesExpectation(texts[index], expectation)) {
        foundIndex = index;
        break;
      }
    }
    if (foundIndex === -1) {
      throw new Error(`${label}: no text matched ${JSON.stringify(expectation)}. Actual: ${JSON.stringify(texts)}`);
    }
    cursor = foundIndex + 1;
  }
}

export function objectContains(actual, expected) {
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (key === "promptContains") {
      const checks = Array.isArray(value) ? value : [value];
      if (!checks.every((needle) => String(actual?.prompt ?? "").includes(String(needle)))) return false;
      continue;
    }
    if (key === "promptNotContains") {
      const checks = Array.isArray(value) ? value : [value];
      if (checks.some((needle) => String(actual?.prompt ?? "").includes(String(needle)))) return false;
      continue;
    }
    if (key === "promptMatches") {
      if (!new RegExp(String(value), "s").test(String(actual?.prompt ?? ""))) return false;
      continue;
    }
    if (actual?.[key] !== value) return false;
  }
  return true;
}

export function assertSchedules(actualSchedules, spec) {
  if (!spec) return;
  assertCount(actualSchedules.length, spec, "schedules");
  const contains = spec.contains === undefined
    ? []
    : Array.isArray(spec.contains) ? spec.contains : [spec.contains];
  for (const expected of contains) {
    if (!actualSchedules.some((schedule) => objectContains(schedule, expected))) {
      throw new Error(`schedules: no schedule matched ${JSON.stringify(expected)}. Actual: ${JSON.stringify(actualSchedules)}`);
    }
  }
}

export function normalizeFileExpectations(spec) {
  if (!spec) return [];
  if (Array.isArray(spec)) return spec;
  if (spec.contains !== undefined || spec.path !== undefined || spec.exists !== undefined) return [spec];
  return [];
}

function listRelativeFiles(rootDir, currentDir = rootDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(rootDir, absolutePath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, absolutePath));
    }
  }
  return files;
}

function resolveExpectedFilePath(workdir, expectation) {
  const relativePath = String(expectation.path ?? "").trim();
  if (relativePath) return relativePath;

  if (expectation.pathMatches !== undefined) {
    const matcher = new RegExp(String(expectation.pathMatches));
    const matches = listRelativeFiles(workdir).filter((candidate) => matcher.test(candidate));
    if (matches.length !== 1) {
      throw new Error(`files: expected exactly one path matching ${JSON.stringify(expectation.pathMatches)}, got ${JSON.stringify(matches)}`);
    }
    return matches[0];
  }

  throw new Error(`files: expectation missing path: ${JSON.stringify(expectation)}`);
}

export function assertFileExpectations(workdir, spec) {
  const expectations = normalizeFileExpectations(spec);
  for (const expectation of expectations) {
    const relativePath = resolveExpectedFilePath(workdir, expectation);
    const targetPath = path.resolve(workdir, relativePath);
    if (!targetPath.startsWith(path.resolve(workdir) + path.sep) && targetPath !== path.resolve(workdir)) {
      throw new Error(`files: path escapes workdir: ${relativePath}`);
    }
    const exists = fs.existsSync(targetPath);
    if (expectation.exists === false) {
      if (exists) throw new Error(`files: expected ${relativePath} not to exist`);
      continue;
    }
    if (!exists) {
      throw new Error(`files: expected ${relativePath} to exist`);
    }
    const text = fs.readFileSync(targetPath, "utf8");
    const containsExpectations = expectation.contains === undefined
      ? []
      : Array.isArray(expectation.contains)
        ? expectation.contains.map((value) => typeof value === "string" ? { contains: value } : value)
        : [{ contains: String(expectation.contains) }];
    for (const containsExpectation of containsExpectations) {
      assertTextExpectations([text], [containsExpectation], `files.${relativePath}`);
    }
    const textExpectations = expectation.text === undefined
      ? []
      : Array.isArray(expectation.text) ? expectation.text : [expectation.text];
    for (const textExpectation of textExpectations) {
      assertTextExpectations([text], [textExpectation], `files.${relativePath}`);
    }
  }
}

export function assertAttachments(attachments, spec) {
  if (!spec) return;
  assertCount(attachments.length, spec.count !== undefined || spec.min !== undefined || spec.max !== undefined ? spec : undefined, "attachments");
  if (spec.pathContains !== undefined) {
    const needle = String(spec.pathContains);
    if (!attachments.some((event) => String(event.payload?.entry?.path ?? "").includes(needle))) {
      throw new Error(`attachments: no attachment path contained ${needle}`);
    }
  }
  if (spec.kind !== undefined) {
    const kind = String(spec.kind);
    if (!attachments.some((event) => String(event.payload?.entry?.kind ?? "") === kind)) {
      throw new Error(`attachments: no attachment kind matched ${kind}`);
    }
  }
}

export function assertExpectations({ scenario, step, stepResult, session, workdir }) {
  const expect = step.expect ?? {};
  const events = stepResult.events;
  const visibleTexts = scenario.mode === "private"
    ? eventTexts(events, ["text", "final"])
    : eventTexts(events, ["text"]);
  const errors = eventTexts(events, ["error"]);
  const attachments = events.filter((event) => event.kind === "attachment");

  if (expect.errors === undefined && errors.length > 0) {
    throw new Error(`unexpected errors: ${JSON.stringify(errors)}`);
  }

  if (expect.noReply) {
    if (visibleTexts.length !== 0) {
      throw new Error(`noReply expected no visible texts, got ${JSON.stringify(visibleTexts)}`);
    }
  }

  assertTextExpectations(visibleTexts, expect.replies, "replies");
  assertTextExpectations(errors, expect.errors, "errors");
  assertAttachments(attachments, expect.attachments);
  assertFileExpectations(workdir, expect.files);
  assertSchedules(session.schedules, expect.schedules);

  const toolCounts = countByTool(events);
  for (const [toolName, spec] of Object.entries(expect.toolCalls ?? {})) {
    assertCount(toolCounts.get(toolName) ?? 0, spec, `toolCalls.${toolName}`);
  }

  if (expect.budgets?.maxSeconds !== undefined && stepResult.durationMs > Number(expect.budgets.maxSeconds) * 1000) {
    throw new Error(`budgets.maxSeconds: expected <= ${expect.budgets.maxSeconds}s, got ${(stepResult.durationMs / 1000).toFixed(1)}s`);
  }
}
