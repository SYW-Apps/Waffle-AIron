# Coding Standards

**Version:** 1.0 · **Date:** 2025-10-01

This document covers how Waffler code should be written — not what to build, but how to
write it well. The central principle is **narrative coding**: code that reads like a clear,
sequential story of what is happening, with each function being a self-contained step.

---

## Narrative Coding

Waffler code is meant to be read and maintained over a long time by different people and
AI agents. Every function, method, and module should tell a clear story.

### What Narrative Coding Means

**Functions as steps:** A function body reads top-to-bottom as a sequence of named,
meaningful steps. Each step either calls a well-named helper or does one obvious thing.

**Bad:**
```rust
pub async fn run_blueprint(&self, id: &str, inputs: HashMap<String, Value>) -> Result<...> {
    let bp = self.store.read().await.blueprints.get(id).cloned()
        .ok_or_else(|| WafflerError::NotFound(id.to_string()))?;
    let exec_id = Uuid::new_v4().to_string();
    let ctx = ExecutionContext::new(self.bus.clone(), inputs.clone(), self.schema_registry.clone());
    let runner = BlueprintRunner::new(bp.clone(), ctx);
    let handle = self.active_registry.write().await.register(exec_id.clone(), runner);
    tokio::spawn(async move { handle.execute().await; });
    Ok(exec_id)
}
```

**Good:**
```rust
pub async fn run_blueprint(&self, id: &str, inputs: HashMap<String, Value>) -> Result<(String, Value)> {
    let blueprint = self.load_blueprint_by_id(id).await?;
    let execution_id = self.generate_execution_id();
    let context = self.build_execution_context(inputs).await;
    let outputs = self.execute_blueprint_to_completion(blueprint, execution_id.clone(), context).await?;
    Ok((execution_id, outputs))
}
```

The second version can be understood in 5 seconds. Each step is a verb phrase that
explains intent. The implementation details live one level down.

### Rules for Narrative Code

1. **One level of abstraction per function.** A function either orchestrates steps (high-level)
   or implements a step (low-level). Never mix both in the same function.

2. **Name every non-obvious step.** If a block of code needs a comment to explain what it does,
   extract it into a named method instead.

3. **Prefer extraction over inlining.** A 10-line private helper with a clear name is better
   than an inline block with a comment. The name is self-documenting; the comment is not.

4. **Keep functions short.** A function body longer than ~25 lines usually contains more than
   one story. Consider splitting it.

5. **Comments explain *why*, not *what*.** The code explains *what*. Write a comment only when
   the *reason* for a decision is non-obvious from reading the code.

---

## Rust Standards

### Error Handling

- Return `Result<T, WafflerError>` for all fallible operations within waffler_core.
- Use `WafflerError` variants consistently — do not invent new string-based errors inline.
- Use the `?` operator to propagate errors. Avoid `.unwrap()` except in tests and in
  situations where the invariant is documented and provably true.
- Never silently swallow errors. If you use `let _ = expr`, add a comment explaining why.
- Use `map_err(|e| WafflerError::X(e.to_string()))` to wrap foreign errors at the boundary.

### Async Code

- Use `tokio::spawn` only when the spawned task is truly independent (fire-and-forget).
  Tasks that produce results the caller needs should be `await`ed directly.
- When spawning, move ownership explicitly with `let x_clone = x.clone(); tokio::spawn(async move { ... })`.
  Always name clones `{original}_clone` to make the relationship obvious.
- Avoid holding `RwLock` or `Mutex` guards across `.await` points. Lock, extract the value,
  drop the guard, then await.

```rust
// Bad: holding a lock across an await
let result = self.store.read().await.get(id).cloned();
some_async_call().await;

// Good: drop the guard before awaiting
let item = {
    let store = self.store.read().await;
    store.get(id).cloned()
};
some_async_call().await;
```

### Arc and Shared State

- Use `Arc<T>` for shared read-only data (orchestrators, registries, stores).
- **Zero-Wait Concurrency (Write-Lock / Read-Swap Hybrid - Preferred Standard):** For shared mutable state where reads outnumber writes (e.g., active configuration, routing metrics, virtual file systems, database caches):
  - **Read Path:** Use `ArcSwap<T>` (or similar atomic pointer swap) to load/read the data. This provides lock-free, wait-free reads (zero blocking, zero read-side lock contention, and eliminates CPU cache-line bouncing).
  - **Write Path:** Protect the write path using a standard `Mutex<()>` (or async Mutex if updating across await points) to serialize updates. The writer acquires the mutex, loads the latest pointer from `ArcSwap`, creates a new modified version, stores the new pointer, and releases the lock.
  - **Why this is the most robust & efficient solution:**
    1. **Zero CPU waste:** Writers that contend for updates are parked by the OS/runtime via the Mutex, consuming 0% CPU (unlike raw CAS loops which spin-wait and thrash the CPU).
    2. **Wait-free reads:** Readers never block, even during active writes, and do not execute atomic writes to cache lines, avoiding cache bouncing.
    3. **No livelocks/starvation:** Serializing writes via a Mutex guarantees progress and prevents writer starvation under heavy write volume.
  - **Avoid raw CAS (Compare-And-Swap) loops** for non-trivial updates, as they cause CPU thrashing, allocator churn, and writer starvation (livelocks) under write congestion.
- **Actor-based Concurrency (Preferred for High-Throughput / Complex Shared State):** For complex state mutations with heavy concurrent reads and writes:
  - Sequence write commands through a single task/thread via an `mpsc` channel (strict FIFO ordering, zero write-path lock contention).
  - Expose the state to readers by having the actor hotswap immutable snapshots via `ArcSwap<T>` or a similar pointer swap.
- Use `Arc<RwLock<T>>` only for general shared mutable state when reads are rare enough that cache-line bouncing is not a bottleneck, writes are infrequent, and non-deterministic read latency or deadlock risk across `.await` points is acceptable.
- Use `Arc<Mutex<T>>` for shared mutable state where writes are frequent, lock times are extremely short, and read blocking is acceptable.
- Never clone an `Arc` without a reason. Passing `&Arc<T>` is fine when you are not storing or spawning with it.

### Logging

Use `tracing` macros (`trace!`, `debug!`, `info!`, `warn!`, `error!`) with structured fields:

```rust
info!(blueprint_id = %id, execution_id = %exec_id, "Blueprint execution started");
error!(blueprint_id = %id, error = %e, "Blueprint execution failed");
```

- `trace!` — Highly detailed, high-frequency events (loop iterations, individual node steps).
- `debug!` — Useful for diagnosing a specific flow, not emitted in production by default.
- `info!` — Significant lifecycle events (service started, blueprint created, package loaded).
- `warn!` — Something unexpected but recoverable happened.
- `error!` — Something failed that requires attention.

Never log secrets, tokens, or user credentials at any level.

### Struct Design

- **Make illegal states unrepresentable.** Use enums and `Option<T>` to model valid states,
  not boolean flags and unchecked strings.
- **Builder pattern for complex construction.** If a struct takes more than ~5 arguments,
  use a builder.
- **Separate public API from internal state.** Fields that are internal implementation
  details should be private, with accessor methods if needed.
- **Derive `Clone`, `Debug`, `Serialize`, `Deserialize` consistently.** If a struct crosses
  any boundary (bus, IPC, storage), it must implement `Serialize + Deserialize`. If it's
  used in logging contexts, derive `Debug`.

### Tests

- Run tests with `cargo nextest run`, not `cargo test`.
- Test names describe behavior: `test_blueprint_run_returns_execution_id`,
  not `test_run` or `test1`.
- Unit tests go in the same file as the code under test, in a `#[cfg(test)] mod tests { }` block.
- Integration tests that need the full waffler_core context go in `tests/`.
- Do not write tests that rely on timing (`sleep`, `timeout`) — use channels and signals instead.
- Do not mock the message bus unless you are specifically testing the bus itself. Use
  a real in-memory broker in integration tests.

---

## TypeScript / JavaScript Standards

### General

- Use TypeScript. Do not write plain `.js` files for new code.
- Enable `strict: true` in `tsconfig.json`. No `any` types without a comment explaining why.
- Prefer `async`/`await` over `.then()` chains.
- Prefer `const` over `let`. Never use `var`.

### Error Handling

- Always `await` Promises in try/catch blocks.
- Never swallow errors silently with empty catch blocks.
- Return structured error objects, not bare strings.

### Naming

Follow the rules in `02_NAMING_CONVENTIONS.md`. Additionally:
- Event handler functions: `on{Event}` — e.g., `onConnect`, `onMessage`.
- Async functions that fetch data: `fetch{Resource}` or `load{Resource}`.
- Type aliases for JSON API shapes: suffix with `Dto` — e.g., `BlueprintDto`.

---

## Code Smell Reference

These patterns indicate that something has gone wrong in the design. Treat them as prompts
to step back and reconsider, not as things to work around.

| Smell | What it suggests |
|-------|-----------------|
| A function with more than 3 `if`/`match` branches that all do similar things | Extract a dispatch table or use polymorphism |
| A struct field named `data`, `info`, `metadata` generically | The field needs a more specific name and possibly its own type |
| A comment that says "// Step 1:", "// Step 2:" | Those steps should be extracted into named functions |
| A `todo!()` or `unimplemented!()` in production code paths | Either implement it or remove the call site |
| `clone()` called more than twice in a row on the same value | Consider restructuring ownership |
| A function that takes a `bool` parameter to switch behavior | Split into two functions |
| Deep nesting (more than 3 levels of `if`/`match`/`for`) | Invert conditions and return early; extract inner loops |
| A `match` arm that does more than ~5 lines of work | Extract into a dedicated function |
| `unwrap()` in non-test code | Must be replaced with proper error handling or a comment that proves it is safe |
| Duplicated logic across two or more call sites | Extract into a shared helper — but only when there are 3+ call sites or the logic is complex |

---

## Deployment Target Awareness

Waffler runs on a wide spectrum of hardware — from enterprise servers to Raspberry Pis
to embedded and PLC-class devices. Code in `waffler_core` and the official SDKs must
never assume a specific deployment environment. The same binary must work correctly
across all supported targets.

### Do Not Assume Abundant Resources

- **Memory:** Do not allocate large buffers, caches, or collections without bounds.
  A cache that grows unboundedly is a memory leak on a device with 256 MB of RAM.
  Apply size limits and eviction policies to all in-memory collections that grow at runtime.
- **CPU:** Do not spin-wait or busy-loop. Use proper async primitives (`tokio::select!`,
  channels, `notify`) to wait for events. A busy loop that is invisible on a 32-core
  server will peg a single-core embedded CPU at 100%.
- **Disk I/O:** Do not assume fast local storage. On SD card–based devices (Raspberry Pi),
  I/O is slow and has a limited write cycle. Batch writes where possible; avoid writing
  on every operation.
- **Startup time:** Do not do expensive work at startup that can be deferred. Package
  loading, index rebuilding, and schema validation should be lazy or parallelised.

### Do Not Assume a Specific OS or Environment

- **Do not use OS-specific APIs directly** in `waffler_core` or the SDKs. Use Rust's
  platform-abstracted standard library or `tokio`'s cross-platform async I/O. Where
  OS-specific behaviour is unavoidable, gate it with `#[cfg(target_os = ...)]` and
  provide an equivalent path for other platforms.
- **Do not assume a GUI or display.** The core has no UI. Do not link UI libraries,
  open windows, or write to stdout as a primary output channel. All output goes through
  the structured logging system (`tracing`) or the message bus.
- **Do not assume network availability.** The core must start and operate correctly
  in fully offline, air-gapped, or local-network-only environments. Network-dependent
  features (package registry, remote telemetry) must be optional and gracefully degrade
  when unavailable.
- **Do not assume a writable home directory or user profile.** On server or embedded
  deployments there may be no user home directory. All paths must be configurable
  relative to the Waffler data directory.

### Do Not Assume a Desktop-Class Client

`waffler_ui` may be running as a Tauri desktop app, a web app in a browser, or it may
not be running at all (headless automation). Core code must not depend on the UI being
present, connected, or responsive. Events published to the bus for UI consumption
should be emitted regardless of whether any UI client is subscribed — the UI subscribes
to the bus; it does not drive the bus.

---

## Do Not Gold-Plate

Waffler code should be exactly as complex as the task requires — no more.

- **Don't add abstraction for one call site.** A helper used only once is just indirection.
  Wait for the second or third use before extracting.
- **Don't add error handling for scenarios that cannot happen.** Trust internal invariants.
  Validate only at system boundaries (user input, IPC, external packages).
- **Don't add configurability that isn't needed.** Hard-code sensible defaults. Add
  configuration only when there is a known requirement to vary the behavior.
- **Don't add feature flags.** If a behavior has changed, change the code. Remove the old
  path. Don't leave it behind a flag.
- **Don't add backwards-compatibility shims.** If something is unused, delete it.
