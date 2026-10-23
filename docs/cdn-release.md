# Releases on the SYW CDN

Every stable, beta and preview release of wairon is also published to the SYW CDN
(`https://cdn.sywapps.com`), beside the GitHub release and npm. The GitHub release
and npm stay the primary channels: `wairon update` and the install scripts read
GitHub, and npm carries the provenance attestation. The CDN copy is for pages and
tools that want a release's files, manifest and guides from one place.

Dev builds (`-dev.N`, one per merge to `dev`) are not published to the CDN; npm's
`dev` tag carries them.

## Where a release lives

A version is published as one exact release per platform, plus an index release
that names them:

```text
https://cdn.sywapps.com/apps/<app>/releases/<version>-<target>/   one platform: its archive + its .sha256
https://cdn.sywapps.com/apps/<app>/releases/<version>/            the index: version.json, notes.md, docs/
https://cdn.sywapps.com/apps/<app>/releases/<alias>/              a mutable alias pointing at one index release
```

`<target>` is `windows-x64`, `linux-x64`, `linux-arm64`, `macos-x64` or `macos-arm64`,
so the Linux x64 archive of 6.1.4 is

```text
https://cdn.sywapps.com/apps/<app>/releases/6.1.4-linux-x64/wairon-6.1.4-linux-x64.tar.gz
```

**Why it is split.** The CDN takes a release as one multipart request, has no staged
or chunked upload, and sits behind Cloudflare, whose standard upload limit is 100 MB
per request. The five archives are 32 to 45 MB each, about 204 MB together: each fits
alone, all five do not (the 6.1.4 publish was refused for that). The CDN's own layout
for this case is one release per platform followed by a small index release. The
publisher keeps every request under the CDN guide's conservative budget of
90,000,000 bytes (the whole encoded body) and refuses, before sending anything, a
request that would exceed it.

`<app>` is the namespace the CDN assigns the wairon publisher. Aliases are moved only
by the index release, after every platform archive was fetched back from its public
URL and matched on SHA-256 and byte length:

| Version | Aliases |
|---|---|
| `6.2.0` (stable) | `latest`, `v6` |
| `6.3.0-beta.1` | `beta` |
| `6.3.0-preview.1` | `preview` |

An exact release directory never changes; an alias is cached for minutes. Read an
alias to discover the current version, then download from the exact URL its
`version.json` gives. 

An alias is never moved over a newer version: before the index is sent, the
publisher reads each alias's public `version.json` (a 404 means the alias is free)
and leaves `latest` / `v<major>` / `beta` / `preview` where they are when the alias
already points at a newer version of that channel (it logs that it skipped them). Any
other answer stops the run before the index is sent. That makes republishing an old tag safe.

## `version.json`

The index release holds `version.json`, the manifest a consumer reads. The archives
are **not** beside it: each is named by the exact URL of its platform release.

```json
{
  "schemaVersion": 2,
  "name": "wairon",
  "version": "6.1.4",
  "tag": "v6.1.4",
  "channel": "stable",
  "released": "2026-10-22T12:00:00.000Z",
  "commit": "<the tagged commit>",
  "npm": { "package": "@wairon/cli", "version": "6.1.4" },
  "source": "https://github.com/SYW-Apps/Waffle-AIron/tree/v6.1.4",
  "notes": "notes.md",
  "docs": "docs/syw-docs.json",
  "files": [
    {
      "platform": "linux-x64",
      "name": "wairon-6.1.4-linux-x64.tar.gz",
      "sha256": "<hex>",
      "bytes": 31457280,
      "release": "6.1.4-linux-x64",
      "url": "/apps/<app>/releases/6.1.4-linux-x64/wairon-6.1.4-linux-x64.tar.gz",
      "checksumUrl": "/apps/<app>/releases/6.1.4-linux-x64/wairon-6.1.4-linux-x64.tar.gz.sha256"
    }
  ]
}
```

- `released` is the time of the tagged commit.
- `channel` is `stable`, `beta` or `preview`.
- `files` lists one archive per platform: `windows-x64` (`.zip`), `linux-x64`,
  `linux-arm64`, `macos-x64` and `macos-arm64` (`.tar.gz`); the set is always
  complete. Each is the same file as on the GitHub release, with its `sha256`.
- `url` and `checksumUrl` are paths on the CDN host (prefix them with
  `https://cdn.sywapps.com`); they point into the platform's own release, never to a
  sibling of `version.json`. `notes` and `docs` are relative to the index release.
- `notes` is present when the release has release notes.
- `schemaVersion` is 2 since the split: version 1 listed `name` / `checksum` beside
  `version.json`, which no longer holds. It changes only when a field changes meaning
  or is removed; new fields may appear without it.

## Guides

`docs/syw-docs.json` is a manifest for the CDN's documentation reader. It
holds the README, the vision and architecture, the CLI reference, networking,
the design export, extending wairon and templates. Links between those pages stay
in the reader; any other link points at the file on GitHub at the release's tag.
Open them at:

```text
https://cdn.sywapps.com/docs?source=apps/<app>/releases/latest/docs/syw-docs.json
```

## Publishing

The `publish-cdn` job of `release.yml` runs `scripts/cdn-publish.mjs` after the
build, with the publisher credential in the `SYW_CDN_PUBLISHER_TOKEN` secret.
Without that secret it does nothing. Nothing else waits on it, so a CDN failure
never holds back the GitHub release or npm. The sequence is:

1. refuse unless the five platform archives (and their `.sha256`) are all there;
2. for each platform, publish `<version>-<target>` (archive + checksum, no aliases),
   then fetch the archive back and check its SHA-256 and length;
3. read each alias's current `version.json` and decide which aliases may move;
4. publish the index `<version>` with those aliases.

A request that fails with a lost response or a 5xx is sent again with the same bytes
(up to three times; the CDN treats an identical republish as idempotent). A `409`
means the CDN holds different bytes under that exact version, and is not retried.
A failure prints the HTTP status, the URL, the body size and the `CF-Ray` /
request id, never the token.

### Recovering a failed publish

A rerun of the original tag run uses that run's workflow and script, so a fixed
publisher on another branch is not picked up. Dispatch the **Republish a release to
the SYW CDN** workflow (`cdn-republish.yml`) from the branch with the fixed script,
with the tag (for example `v6.1.4`). It downloads that tag's already-built archives
from the GitHub release (nothing is rebuilt, the tag does not move), takes the
release time from the tag's commit, and runs the same script.

To see what would be published, without a credential:

```sh
node scripts/cdn-publish.mjs --version 6.2.0 --artifacts <dir with the five archives> --dry-run <out-dir>
```

The dry run writes one folder per release (its files and a `request.json` with the
aliases and the encoded body size) and sends nothing.
