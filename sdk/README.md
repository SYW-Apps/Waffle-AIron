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
  inspectArchive, // inspect + version-check a .wpack without extracting
  extractPack,    // SAFELY extract a .wpack under enforced limits
} from '@wairon/sdk';
```

### Safety model

`extractPack` never writes anything unsafe: before a single byte is inflated,
the codec plans the extraction from the archive's central-directory metadata and
rejects zip-slip (`..`, absolute, backslash, drive-letter paths), symlinks and
non-regular entries, and anything over the caps (entry count, total inflated
size, per-entry size, compression ratio, path depth). Integrity is verified
before the tree is written, so a tampered pack never lands.

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
