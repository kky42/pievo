# Pievo — connect this machine and create a scheduled prompt

You're reading this because the user pasted a Pievo capture snippet (`Fetch
<server-url>/api/bootstrap and help me build a loop.`). Their Pievo web tab is waiting
for the machine and new loop. Work end to end, with short confirmations rather than a
long interview.

## Pasted values

Use these values exactly as supplied:

- **server-url** — the Pievo server base URL.
- **connect-key** — the one-time machine connection and web-dialog claim.
- **pievo-cli** *(optional)* — the command prefix for every Pievo invocation. If it is
  absent, use `pievo` after installing the current package.
- An optional task description below the values — the requested scheduled prompt.

## 1 · Connect

Fetch and follow the connection reference:

```text
<server-url>/api/skill/references/connect.md
```

Pass the pasted `server-url` and `connect-key` to its daemon start command. Do not
replace a supplied custom `pievo-cli` prefix.

## 2 · Create

After the daemon reports the machine online, fetch and follow:

```text
<server-url>/api/skill/references/create.md
```

The create reference owns the remaining flow: identify the concrete prompt, confirm
its exclusive cron or continuous schedule and three status definitions, choose the
working directory and coding agent, optionally select exact artifact files, preview the
canonical JSON, and run `pievo new`. On this first-capture path, pass the same
`connect-key` to `pievo new` so the created loop appears in the waiting web dialog.

Pievo is a scheduled prompt runner. Configure only the fields listed in the create
reference. The stored user prompt is delivered unchanged, followed only by Pievo's
complete status/report contract.
