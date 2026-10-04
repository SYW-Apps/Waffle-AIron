# wairon — Language Bindings

> The [Architecture Standard](architecture.md) is language-neutral: it prescribes
> *strategies* (e.g. "wait-free reads / in-order serialized writes"), not
> primitives. This appendix maps those strategies onto concrete primitives per
> language. The structural model (blocks, patterns, `owns`/`dependsOn`, layering)
> is identical everywhere — only the realization below differs.

---

## Structural mapping

The model assumes a class-with-methods style and method-only interfaces. Every
mainstream structured language expresses this:

| Concept | Rust | Go | TypeScript / Java / C# / Kotlin | Python |
|---|---|---|---|---|
| "class" (component) | `struct` + `impl` | `struct` + methods | `class` | `class` |
| module of functions (an Orchestrator) | closures capturing the collaborators, or a module of `fn`s taking a `&Deps` | a constructor func returning a struct of closures | TypeScript/Kotlin: a factory `createX(deps)` returning functions closed over `deps`; Java/C#: the class form | a factory returning closures over the collaborators |
| interface (method contract) | `trait` | `interface` | `interface` | `Protocol` / ABC |
| port + implementations | trait + impl structs | interface + structs | interface + classes | Protocol + classes |
| dependency injection | constructor (`new`) | constructor func | constructor | `__init__` |

Interfaces are **method contracts only** (no fields). Languages whose interfaces
can't declare fields (Rust traits, Go interfaces) lose nothing — fields are an
implementation detail of the concrete type, never part of the L3 contract.

**Two forms of an Orchestrator.** An Orchestrator holds only its collaborators, so
it is realized either as a class whose constructor takes them, or as a **module of
functions** closed over them: a factory takes the collaborators once and returns
the component's methods as functions that share them. Functional languages use the
second form natively — a function that takes the collaborators and returns a
record or map of functions closed over them, or partial application. In both forms
the collaborators are the component's `dependsOn` and the functions are its L3
methods, and nothing at module level holds state between calls: domain state
belongs in a Store, runtime state in an Actor.

---

## Type mapping

Contracts are typed in the neutral grammar of the
[Architecture Standard](architecture.md#type-expressions-one-neutral-grammar);
each language spells it with what it has. The TypeScript column is the dialect
conformance reads code through, and the one an implementer brief carries as
its `typeMapping`; the others are the idiomatic spellings to follow.

| Neutral | TypeScript | Rust | Python | Go | Java / Kotlin / C# |
|---|---|---|---|---|---|
| `string` | `string` | `String` | `str` | `string` | `String` / `String` / `string` |
| `int`, `float` | `number` | `i64`, `f64` (width per L4) | `int`, `float` | `int64`, `float64` | `long`, `double` |
| `bool` | `boolean` | `bool` | `bool` | `bool` | `boolean` / `Boolean` / `bool` |
| `bytes` | `Uint8Array` | `Vec<u8>` | `bytes` | `[]byte` | `byte[]` / `ByteArray` / `byte[]` |
| `date`, `datetime`, `duration` | `string` (ISO 8601) | `chrono` types | `date`, `datetime`, `timedelta` | `time.Time`, `time.Duration` | `java.time` / `DateTime`, `TimeSpan` |
| `list<T>` | `T[]` | `Vec<T>` | `list[T]` | `[]T` | `List<T>` |
| `set<T>` | `Set<T>` | `HashSet<T>` | `set[T]` | `map[T]struct{}` | `Set<T>` |
| `map<K, V>` | `Record<K, V>` | `HashMap<K, V>` | `dict[K, V]` | `map[K]V` | `Map<K, V>` / `Dictionary<K, V>` |
| `T?` | `T \| null` | `Option<T>` | `T \| None` | `*T` | nullable `T` / `T?` |
| `A \| B` | `A \| B` | `enum` with payload | `A \| B` | an interface both implement | `sealed` hierarchy |
| `async T` | `Promise<T>` | `async fn` → `T` | `async def` → `T` | a blocking call or a channel | `CompletableFuture<T>` / `suspend` / `Task<T>` |
| enum `E` | `type E = 'a' \| 'b'` | `enum E` | `class E(StrEnum)` | typed `string` constants | `enum E` |
| named scalar `E` holding `P` | `type E = P` | `struct E(P)` | `E = NewType('E', P)` | `type E P` | a value class / `@JvmInline value class E` / `record struct E(P)` |
| `any` | `unknown` | `serde_json::Value` | `Any` | `any` | `Object` / `Any` / `object` |

---

## Concurrency strategy → primitives

### Default: wait-free reads / in-order serialized writes

Readers load a snapshot reference without blocking; writers are serialized so they
apply in order; on commit the reference is atomically swapped for all readers;
values are held by reference so the swap is pointer-only.

| Language | Reads | Writes |
|---|---|---|
| **Rust** | `ArcSwap<T>::load()` (wait-free) | `Mutex<()>` to serialize, clone-and-`store(Arc::new(...))` |
| **Go** | `atomic.Value` / `atomic.Pointer[T]` load | `sync.Mutex` to serialize, store new pointer |
| **Java** | `AtomicReference<T>.get()` | a lock to serialize, `set(newRef)` (or `ConcurrentHashMap` for maps) |
| **C#** | `Volatile.Read` / `Interlocked` ref read | `lock` to serialize, swap reference |
| **TypeScript (Node)** | single-threaded event loop — a plain reference read | sequential by the event loop; for workers use a message-passing queue |

### Single value, simple read-modify-write (counter, flag)

| Language | Primitive |
|---|---|
| Rust | `AtomicU64::fetch_add` / `compare_exchange` |
| Go | `atomic.AddInt64` / `atomic.CompareAndSwap` |
| Java | `AtomicLong.incrementAndGet` |
| C# | `Interlocked.Increment` / `CompareExchange` |
| TS (Node) | sequential on the event loop; `Atomics` on a `SharedArrayBuffer` across workers |

Prefer the atomic op over a lock for a single value: it is one wait-free
instruction, totally ordered, and cheaper than a mutex (which is itself built on
atomics and may incur a syscall + context switch under contention). Use a
compare-and-set **retry loop** only for a compound update of one location that has
no single-instruction equivalent — never as a general strategy over composite
state (it can livelock and wastes cycles).

### Exceptions to the default

| Situation | Rust | Go | Java |
|---|---|---|---|
| write-heavy large map | `DashMap` (sharded) or `im`/`rpds` (persistent) | sharded `map`+`RWMutex`, or `sync.Map` | `ConcurrentHashMap` |
| cross-store atomic transaction | DB transaction via the Adapter | DB transaction via the Adapter | DB transaction via the Adapter |
| single-writer (Actor) state | `ArcSwap` reads, no write lock | `atomic.Pointer`, no mutex | `AtomicReference`, no lock |
| non-shared / write-once | plain ownership / `OnceCell` | plain field / `sync.Once` | `final` / `OnceCell` equivalent |

---

## Notes

- In single-threaded runtimes (Node.js) the concurrency machinery collapses to
  plain references; apply the *strategy* (one writer at a time, readers see a
  consistent snapshot) at the worker/message-queue boundary instead.
- The zero-copy/reference rule (§11 of the standard) assumes shared references are
  cheap and safe. Where a language copies by value, use the language's shared-
  reference type (smart pointer / GC reference) so Indexes hold pointers, not value
  copies.
