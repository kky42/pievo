# Contributing to Pievo

Thanks for your interest in contributing! This guide covers the basics for
getting set up and landing a change.

## Repo layout

Pievo is a pnpm monorepo with two packages:

- **`packages/server`** (`@kky42/pievo-server`, private) — the TanStack Start web app:
  UI + server functions + the in-process scheduler + machine/agent routes + Better
  Auth + artifact storage. Drizzle over Postgres: embedded PGlite when
  `DATABASE_URL` is unset, or postgres-js against an external Postgres when set.
- **`packages/daemon`** (`@kky42/pievo`, public on npm) — the machine-side
  daemon that runs on each user's own machine, polls the server for due runs, and
  executes them via the user's local coding agent (BYOA).

`AGENTS.md` is the in-repo design/decision log — read it for architecture context.

## Prerequisites

- Node.js `>= 22`
- pnpm `8.15.0` (pinned via the root `packageManager` field; `corepack enable`
  picks it up automatically)

## Install

```bash
pnpm install
```

## Run the server locally

```bash
pnpm dev          # server on http://127.0.0.1:3000 (UI + scheduler + machine routes)
```

Copy `.env.example` to `packages/server/.env` if you need to configure auth,
the artifact blob store, or other options. The app runs open (no auth) by default.

> Changed `packages/server/src/db/schema.ts`? Author the migration SQL and
> snapshot, then restart local dev so embedded PGlite applies it in-process:
> ```bash
> pnpm --filter @kky42/pievo-server db:generate
> pnpm dev
> ```
> `db:migrate` is only for a separately configured real Postgres and requires
> `DIRECT_DATABASE_URL`/`DATABASE_URL`; it is not the local PGlite migration path.

## Tests & typecheck

```bash
pnpm -r test                          # run every package's test suite
pnpm --filter @kky42/pievo-server test    # server only
pnpm --filter @kky42/pievo test   # daemon only
pnpm -r typecheck                     # typecheck both packages
```

Please keep tests and `typecheck` green before opening a PR.

## Branches & pull requests

- Branch off `main` for your change; keep the branch focused.
- Open a PR against `main`. Merging does not deploy a server; the optional Fly
  workflows are manual-only and inert until a maintainer configures resources.
- Write a clear PR description: what changed and why.

## Releases

- **Server** — no deployment target is configured. Both Fly workflows are
  manual-only examples and fail before `flyctl` unless their explicit app/origin
  GitHub vars and token secrets are set. `fly.toml` is the embedded-PGlite example;
  `fly.prod.toml` is the external-Postgres/object-store example. Migrations remain
  forward-only: an image rollback does not roll back schema.
- **Daemon** (`@kky42/pievo`) — publishes to npm on a `vX.Y.Z` git tag
  (`.github/workflows/publish-daemon.yml`, via npm OIDC trusted publishing). The
  tag must match `packages/daemon/package.json`. During this takeover, publish the
  first Pievo daemon before deploying a server whose generated snippets invoke
  `npx @kky42/pievo@latest`; until then that registry tag may still be the legacy
  project, so development servers should set `PIEVO_CLI` to the local daemon.

## Licensing

Pievo is licensed under the [MIT License](LICENSE), and every package is MIT:

- **`packages/daemon`** (`@kky42/pievo`) — [MIT](packages/daemon/LICENSE).
- **`packages/server`** (`@kky42/pievo-server`) — [MIT](packages/server/LICENSE).

Contributions are accepted under the MIT license (inbound=outbound): by opening
a pull request you agree that your contribution is provided under the same MIT
license as the project. There is **no CLA** and **no DCO / sign-off**
requirement - nothing extra to sign, and you keep the copyright to your work.
