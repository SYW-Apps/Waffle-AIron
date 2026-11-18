# @wairon/sdk

The pack-archive format authority and authoring toolkit for [wairon](https://github.com/SYW-Apps/Waffle-AIron).

It owns the portable, versioned **`.wpack`** archive format: a ZIP whose root
carries a `wairon-pack.yaml` envelope (identity, format/runtime compatibility,
optional per-entry integrity) wrapping an ordinary directory pack (`pack.yaml`
for declarative packs, `pack.cjs` for code packs, `skills/**/SKILL.md`, …).

It is deliberately **standalone and dependency-free** with respect to the rest
of wairon, so third-party pack authors can depend on only `@wairon/sdk`. It does
STRUCTURAL / envelope validation only — semantic declarative-pack validation
stays in wairon core and runs after extraction.

## API

```ts
import {
  scaffoldPack,   // scaffold a new pack project (declarative | code)
  buildPack,      // build an installable .wpack from a pack directory
  inspectArchive, // inspect + version-check a .wpack without extracting (entries vetted under limits first)
  readPack,       // read a .wpack in memory under the guards: envelope, inner manifest, files
  extractPack,    // SAFELY extract a .wpack under enforced limits
  PackArchiveError, // what every .wpack reader throws; match on its `code`
  packContentDigest, // the content integrity (sha256-<hex>) wairon pins, over a pack's files
} from '@wairon/sdk';
```

### Safety model

`extractPack` never writes anything unsafe: before a single byte is inflated,
the codec plans the extraction from the archive's central-directory metadata and
rejects zip-slip (`..`, absolute, backslash, drive-letter paths), symlinks and
non-regular entries, and anything over the caps (entry count, total inflated
size, per-entry size, compression ratio, path depth). Integrity is verified
before the tree is written, so a tampered pack never lands.

`inspectArchive` and `readPack` run the same guards: every entry is vetted under the
limits (default or yours) before anything, the envelope included, is inflated. `readPack`
returns `{ manifest, packManifest, files }` and writes nothing: the parsed envelope, the inner
pack manifest as authored (`pack.yaml`, or `package.json` of a code pack) and every approved
file, integrity-checked when the envelope carries digests and checked for envelope/inner
name and version agreement. `extractPack` is `readPack` followed by the write.

Every refusal is a `PackArchiveError` with a stable `code` (match on it, not on the message):

| code | meaning |
| --- | --- |
| `NOT_A_PACK` | no `wairon-pack.yaml` envelope |
| `UNSAFE_PATH` | symlink, non-file kind, or an absolute / backslash / drive-letter / `..` / escaping path |
| `LIMIT_EXCEEDED` | an entry or the archive is over a cap (entry size, ratio, depth, count, total) |
| `ENVELOPE_INVALID` | the envelope is not a YAML mapping, or a required field is missing or mistyped |
| `FORMAT_VERSION_UNSUPPORTED` | the envelope format is newer than this SDK understands |
| `PACK_MANIFEST_INVALID` | the inner pack manifest is missing, unreadable or not a mapping |
| `IDENTITY_MISMATCH` | envelope name/version differ from the inner manifest's |
| `DIGEST_MISMATCH` | a file's bytes do not match the digest the envelope carries |

Whole in-memory buffers only (never streams) — the zip-bomb guard must enumerate
entry sizes *before* decompression. The `bytes` surface is `Uint8Array` (Node's
`Buffer` is accepted transparently).

### Authoring code packs

```ts
import { defineRule, type RuleContext, type Finding } from '@wairon/sdk';

export default {
  name: 'my-rules',
  rules: [
    defineRule({
      name: 'my-example',
      description: 'Example architectural doctrine.',
      codes: ['MY_EXAMPLE'],
      check(ctx: RuleContext): Finding[] {
        return [];
      },
    }),
  ],
};
```

## License

MIT
