import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bundle = path.join(root, "skill");

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), childRel);
      else out.push(childRel);
    }
  };
  walk(dir, "");
  return out.sort();
}

test("skill bundle contains exactly SKILL/connect/create/update", () => {
  expect(listTree(bundle)).toEqual([
    "SKILL.md",
    "references/connect.md",
    "references/create.md",
    "references/update.md",
  ]);
});
