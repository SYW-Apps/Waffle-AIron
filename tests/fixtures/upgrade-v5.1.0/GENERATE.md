# upgrade-v5.1.0 fixture

A small shop project written and locked by the PUBLISHED `@wairon/cli@5.1.0`, used by
`tests/e2e/upgrade-from-v5.1.0.test.ts`. No LLM was involved.

## What it holds

- `.wai/`: an L0 (Shopfront), two subsystems (`catalog`, `orders`), each shaped
  Portal -> Orchestrator -> Repository(Store), with interfaces, endpoints and narratives;
  a client Adapter in `orders` that calls the chained billing Portal; and the lock
  v5.1.0 took.
- `services/billing/.wai/`: the chained subproject in v5.1.0's own form. The parent
  carries an L1 mount (`projectPath: services/billing`), and the child is a project of
  its own (L0, subsystem `charges`, Portal -> Orchestrator, a published surface).

## How it was generated

```
node qa/scripts/gen-upgrade-fixture.mjs --version 5.1.0 --out tests/fixtures/upgrade-v5.1.0
```

The script installs `@wairon/cli@5.1.0` into a scratch folder with a private HOME, runs
`wairon init --yes` and `wairon subsystem add`, then authors the design by calling
that release's own MCP tools over stdio (`sdd_*`). It runs that release's `wairon lock`,
and copies the two `.wai/` trees here. The only edit afterwards is the approver name in
`.wai/lock.json` (`lockedBy`), replaced with `qa-fixture` so no machine user is committed.

The files are the exact bytes v5.1.0 wrote (LF). `.gitattributes` marks this folder
`-text` so no checkout converts them, and the test normalises line endings anyway.

## Regenerating

Do not edit these files by hand. To refresh the fixture for a later release, run the
script with the previous stable's version and a matching `--out` (for example
`tests/fixtures/upgrade-v6.0.0`), then point the test at it.
