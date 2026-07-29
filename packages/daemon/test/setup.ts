import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-daemon-test-"));

process.env.PIEVO_HOME = testHome;
delete process.env.PIEVO_TOKEN;
delete process.env.PIEVO_SERVER_URL;
delete process.env.PIEVO_RUN_TOKEN;

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});
