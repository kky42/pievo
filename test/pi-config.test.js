import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";

async function writeAgentConfig({ rootDir, agentId = "agent", profile, bindings = {} }) {
  const agentDir = path.join(rootDir, agentId);
  const workdir = path.join(rootDir, ".workdir");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "config.json"),
    `${JSON.stringify(
      {
        profile: {
          workdir,
          auto: "medium",
          model: "default",
          reasoningEffort: "default",
          ...profile
        },
        bindings
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return { workdir };
}

test("loadConfig rejects profile.cli because Pievo is Pi-only", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-config-"));
  await writeAgentConfig({
    rootDir: tempDir,
    profile: {
      cli: "pi"
    }
  });

  await assert.rejects(
    loadConfig(tempDir),
    /profile\.cli is no longer supported\. Pievo always uses Pi\./
  );
});

test("loadConfig loads Pi-only profiles without cli state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-config-"));
  const { workdir } = await writeAgentConfig({
    rootDir: tempDir,
    profile: {}
  });

  const config = await loadConfig(tempDir);

  assert.equal(config.agents.length, 1);
  assert.equal(config.agents[0].id, "agent");
  assert.equal(config.agents[0].workdir, workdir);
  assert.equal(Object.hasOwn(config.agents[0], "cli"), false);
});

test("loadConfig accepts configured usernames without mention prefixes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-config-"));
  await writeAgentConfig({
    rootDir: tempDir,
    profile: {},
    bindings: {
      telegram: {
        allowedUsernames: ["AllowedUser"],
        managerUsernames: ["Manager"],
        bots: [
          {
            username: "RelayBot",
            token: "token",
            allowedUsernames: ["BotUser"],
            managerUsernames: ["Owner"]
          }
        ]
      }
    }
  });

  const config = await loadConfig(tempDir);
  const [bot] = config.telegramBots;

  assert.equal(bot.username, "relaybot");
  assert.deepEqual(bot.managerUsernames, ["manager", "owner"]);
  assert.deepEqual(bot.allowedUsernames, ["alloweduser", "botuser", "manager", "owner"]);
});

test("loadConfig rejects configured usernames with mention prefixes", async () => {
  const cases = [
    {
      name: "telegram bot username",
      bindings: {
        telegram: {
          bots: [{ username: "@relaybot", token: "token", allowedUsernames: ["user"] }]
        }
      },
      pattern: /bindings\.telegram\.bots\[0\]\.username must be written without "@"/
    },
    {
      name: "telegram manager username",
      bindings: {
        telegram: {
          managerUsernames: ["@manager"],
          bots: [{ username: "relaybot", token: "token", allowedUsernames: ["user"] }]
        }
      },
      pattern: /bindings\.telegram\.managerUsernames\[0\] must be written without "@"/
    },
    {
      name: "mattermost bot username",
      bindings: {
        mattermost: {
          bots: [
            {
              serverUrl: "https://chat.example.com",
              username: "@relaybot",
              token: "token",
              allowedUsernames: ["user"]
            }
          ]
        }
      },
      pattern: /bindings\.mattermost\.bots\[0\]\.username must be written without "@"/
    }
  ];

  for (const scenario of cases) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `pievo-config-${scenario.name}-`));
    await writeAgentConfig({
      rootDir: tempDir,
      profile: {},
      bindings: scenario.bindings
    });

    await assert.rejects(loadConfig(tempDir), scenario.pattern);
  }
});
