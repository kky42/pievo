# Pievo Fresh-Deploy Zero-Compatibility Plan

## 1. Mandate

Pievo ships one current contract for fresh deployments. Server, daemon, database,
CLI, web UI, tests, documentation, and package artifacts must agree on that contract.
There are no alternate wire responses, permissive parsers, write aliases, schema data
transforms, or dormant compatibility branches.

The server remains a zero-exec control plane. It may authenticate, validate, hash,
schedule, persist, diff, and serve bytes. Only the daemon may launch a coding agent or
execute user work.

## 2. Canonical loop contract

A loop accepts exactly these owner-facing fields:

- required `name`, `schedule`, `workdir`, `agent`, `prompt`, and complete
  `statusDefinitions`;
- optional `model`, `reasoningEffort`, and exact relative `artifacts` paths;
- boolean `enabled`.

`schedule` is an exact discriminated union:

```ts
{ mode: "cron", cron: string, timezone: string, overlap: "skip" | "queue-one" }
{ mode: "continuous", delayMinutes: number }
```

All fields are validated by `packages/server/src/gateway/loopConfig.ts`. Values must
already have their canonical JSON types. In particular, `delayMinutes` is an integer
JSON number of at least one; strings and booleans are rejected rather than converted.
Unknown keys and mixed cron/continuous shapes fail loudly.

## 3. Terminal report contract

The daemon persists and sends one JSON object with this exact top-level allowlist:

```text
reportId, runId, result, exitCode, durationMs,
sessionId, usage, error, finalText
```

`reportId`, `runId`, and `result` are semantically required. Present diagnostics are
strictly typed:

- `durationMs`: non-negative 32-bit integer;
- `exitCode`: non-negative 32-bit integer or `null`;
- `sessionId`, `error`, `finalText`: strings;
- `usage`: object containing only `inputTokens`, `outputTokens`,
  `cacheReadTokens`, and `cacheCreationTokens`; every present count is a finite,
  non-negative integer no greater than `1e12`.

A correlatable invalid payload follows the same durable terminal seam as any handled
report: the server stores `REPORT_INVALID`, terminalizes or preserves the run as
appropriate, consumes authority, and returns the exact digest-bound 200 ACK. An
uncorrelatable report ID remains authenticated, mutation-free, and nonterminal.

## 4. Daemon outbox acknowledgement contract

`pending-reports.sqlite` retains the byte-identical payload, SHA-256 digest, run token,
attempt state, and latest diagnostic until one of these exact responses arrives:

1. normal 200 ACK: `{ ok: true, reportId }`;
2. handled 200 ACK: `{ ok: true, accepted: false, terminal: true, reportId, code,
   issues, disposition, payloadDigest }`, with current enum values and the exact local
   digest;
3. retired 410 ACK: `{ error: "execution authority retired", code: "RETIRED",
   reportId }`.

No other status or body shape consumes the row. Non-current responses are recorded as
retry diagnostics and use the normal bounded backoff. Every durable row is restored as
`reporting` on daemon startup, and independent rows do not block unrelated loops.

## 5. Daemon dispatch gate

Protocol v4 dispatch requires a complete canonical SemVer package version meeting
`MIN_DAEMON_VERSION`. Missing, partial, prefixed, whitespace-padded, leading-zero, or
trailing-garbage values fail closed: the server returns `needsUpdate`, leaves pending
work unclaimed, and records no delivery. Protocol-number mismatch remains HTTP 426.

## 6. Current machine and owner surfaces

Machine traffic uses the current poll, CLI, report, artifact manifest, and blob ingress
routes. Run credentials authorize only `report` and its help. Device credentials own
loop creation/editing, lifecycle controls, history, and machine operations. Comments,
tests, help, and documentation use these current route names.

The database has one reviewed baseline SQL file and one journal entry matching the
fresh schema. Generated Drizzle snapshots are not committed.

## 7. Zero-legacy application surface

The callback accepts report text only as `--message`, and the daemon transports argv
verbatim. `spawn.execEnv` always requires an
explicit coding agent so credentials cannot be selected by an implicit default.

Poll ingress validates the complete envelope before loading the gateway. `host`,
`platform`, `arch`, and `version` are absent or strings, reject NUL, and obey their
wire caps. The gateway repeats these checks before authentication, presence updates,
enrollment, protocol persistence, heartbeat writes, or claims, so invalid requests
return 400 without mutation.

The client/server read model is loop-native: `LoopSummary`, `LoopFull`, `LoopDetail`,
and `LoopPayload`, served by `listLoops`, `getLoopDetail`, `patchLoop`, and the
loop-named lifecycle functions. `server/loopProjection.ts` is the single projection
module. `RunSummary.phase` is the required canonical lifecycle fact; it has no
parallel queued/running/canceled booleans. UI labels and controls derive from phase.
Machine scoping helpers are imported from their owning module rather than re-exported
through `machineFns.ts`.

## 8. Implementation map

- `packages/daemon/src/report-outbox.ts`: exact ACK recognizers, retry persistence,
  diagnostics, and row deletion.
- `packages/daemon/src/daemon.ts`: startup hydration and report-drain lifecycle.
- `packages/server/src/gateway/index.ts`: strict terminal validation and durable ACKs.
- `packages/server/src/gateway/protocol.ts` and `src/lib/semver.ts`: fail-closed
  dispatch version gate.
- `packages/server/src/gateway/loopConfig.ts`: exact canonical JSON validation and
  fail-closed reconstruction of stored schedules.
- `packages/server/src/db/{schema,store}.ts`: no database defaults for canonical
  required loop fields; complete internal schedule writes and non-null ownership scope.
- `packages/server/src/routes/api.machine.cli.ts`: exact `{argv:string[]}` ingress.
- `packages/server/src/routes/api.machine.poll.ts`: pre-gateway exact poll validation.
- `packages/server/src/server/{loopApi,loopProjection}.ts`: canonical loop read/write surface.
- `packages/daemon/src/{cli-client,spawn}.ts`: verbatim argv and explicit agent credential selection.
- root and package `AGENTS.md`: durable contract guidance.

## 9. Verification

Required checks:

```bash
pnpm --filter @kky42/pievo-server test
pnpm --filter @kky42/pievo test
pnpm -r typecheck
pnpm --filter @kky42/pievo-server build:publish
pnpm --filter @kky42/pievo-server verify:package
pnpm --filter @kky42/pievo build
```

Also verify:

- focused strict-report, outbox, SemVer-gate, loop-config, schema-contract, timezone
  invariant, and exact CLI-envelope tests;
- repository search for stale machine-route terminology, compatibility ACK logic,
  non-null field fallbacks, loop-column defaults, and raw cron write surfaces;
- baseline Drizzle SQL/journal shape and absence of generated snapshots;
- final diff for accidental generated files or unrelated edits.

The spend-bearing provider telemetry test is required only when provider collector
schemas or parsing change.

## 10. Conformance record

| Contract | Result | Evidence |
|---|---|---|
| Canonical loop JSON types | Verified | Focused validator tests reject string/boolean delay values and other non-canonical field types; create maps every schedule union to all internal cadence columns. |
| Required persistence facts | Verified | Schema-contract tests prove canonical required loop columns have no DB defaults and `machines`/`loops`/`connect_keys` always materialize non-null team scope; `createLoop` requires a complete internal schedule. |
| Cron timezone invariant | Verified | Canonical validation requires an IANA timezone, writes it explicitly, and focused tests prove a cron row missing it throws instead of reconstructing UTC/local-time fallback. |
| Exact machine CLI ingress | Verified | Route tests cover invalid JSON, null/array/non-object, missing/non-array/non-string `argv`, and unknown fields as pre-boot 400s; only exact `{argv:string[]}` parses. |
| Strict terminal report validation | Verified | Lifecycle tests cover exact top-level keys plus invalid `sessionId`, `finalText`, `error`, usage shape, token types, finiteness, range, and unknown keys. |
| Exact durable daemon ACK handling | Verified | Outbox/runtime/status tests cover exact 200/410 consumption, digest/disposition binding, non-current 409/422 retry, restart hydration, and independent rows. |
| Fail-closed SemVer dispatch | Verified | SemVer and poll tests reject partial, prefixed, padded, leading-zero, and trailing-garbage versions without claiming work. |
| Current route terminology | Verified | Repository search has no retired machine-route or pre-loop application terminology in current files. |
| Zero-legacy callback | Verified | Callback/client tests and documentation expose only `--message`, and argv is transported verbatim. |
| Strict poll identity | Verified | HTTP and gateway tests reject non-string, NUL-bearing, over-cap, and unknown machine info before mutation. |
| Canonical loop projection | Verified | Loop projections and UI expose Loop-named types/functions; `RunSummary` carries only required `phase`. |
| Explicit child credential scope | Verified | Every `execEnv` caller passes its coding agent and tests cover both credential allowlists. |
| Fresh baseline schema/package output | Verified | `drizzle-kit check` passes; layout is one baseline SQL plus one journal and no snapshots; server and daemon package inspections contain required assets. |
| Full tests, typecheck, and builds | Verified | Server: 450 passed / 3 skipped; daemon: 237 passed / 2 skipped; workspace typecheck, `git diff --check`, `drizzle-kit check`, strict server build, daemon build, and package verification pass. |

No conformance divergence remains. Provider collectors were unchanged, so the
spend-bearing real-provider telemetry suite was not run.
